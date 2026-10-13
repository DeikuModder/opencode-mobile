import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common"
import type { Request, Response } from "express"
import { APP_CONFIG, RATE_LIMIT_STORE } from "./tokens.js"
import type { FixedWindowStore } from "./rate-limit.js"
import type { AppConfig } from "./config.js"

interface Bucket {
  limit: number
  windowMs: number
}

const MINUTE = 60_000

/**
 * Per-IP fixed-window rate limiting.
 *
 * Login gets its own, much tighter bucket than the rest of the API. Both layers
 * exist because neither is sufficient alone: a per-IP limit is trivially
 * evaded by rotating source addresses, while AuthService's per-username TOTP
 * limiter is the one that survives that. The password check itself is bounded
 * by scrypt's cost, so an unauthenticated flood cannot run free either.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name)

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: FixedWindowStore,
  ) {}

  private bucketFor(req: Request): Bucket {
    if (req.path === "/api/auth/login") {
      return { limit: this.config.rateLimit.loginPerMinute, windowMs: MINUTE }
    }
    return { limit: this.config.rateLimit.globalPerMinute, windowMs: MINUTE }
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp()
    const req = http.getRequest<Request>()
    const res = http.getResponse<Response>()

    const { limit, windowMs } = this.bucketFor(req)
    // trust proxy is set in main.ts, so req.ip is the real client behind
    // cloudflared rather than 127.0.0.1 for every request.
    const result = this.store.hit(`${req.ip ?? "unknown"}:${req.path}`, limit, windowMs)

    res.setHeader("X-RateLimit-Limit", String(limit))
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - result.count)))
    res.setHeader("X-RateLimit-Reset", String(result.resetSeconds))

    if (result.limited) {
      this.logger.warn(`rate limit hit for ${req.ip} on ${req.path}`)
      if (result.retryAfterSeconds > 0) res.setHeader("Retry-After", String(result.retryAfterSeconds))
      throw new HttpException(
        { code: "rate_limited", message: "Too many requests. Try again shortly." },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    return true
  }
}
