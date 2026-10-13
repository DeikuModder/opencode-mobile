import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common"
import type { Request } from "express"
import { APP_ORIGIN } from "../tokens.js"
import { isMutatingMethod, isOriginAllowed } from "./origin.js"
import { AuthService } from "./service.js"

/**
 * CSRF protection for every mutating request, applied globally.
 *
 * This is a separate guard from SessionGuard on purpose. Login is a mutating
 * endpoint that must work without a session, so putting the Origin check only
 * on authenticated routes left the login endpoint unprotected against
 * login-CSRF (an attacker page silently signing the victim into an account the
 * attacker controls).
 *
 * The cookie is SameSite=Strict, which already blocks cross-site use of
 * authenticated requests in modern browsers; this is the layer that does not
 * depend on the browser, and the one that also covers login.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_ORIGIN) private readonly appOrigins: readonly string[],
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>()
    if (!isMutatingMethod(req.method)) return true

    // CSRF is a browser problem: it works by making the browser attach a
    // credential it holds ambiently (our cookie). A caller presenting its own
    // bearer token is not the browser, and a cross-site page cannot make the
    // browser attach an Authorization header, so those requests are exempt.
    //
    // The token is fully validated first. Trusting the mere presence of the
    // header would hand any attacker page a one-line CSRF bypass.
    if (this.hasValidBearer(req)) return true

    if (!isOriginAllowed(req.headers.origin, this.appOrigins)) {
      throw new ForbiddenException({
        code: "bad_origin",
        message: "Request origin is not allowed",
      })
    }
    return true
  }

  private hasValidBearer(req: Request): boolean {
    const header = req.headers.authorization
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false
    return this.auth.resolveBearerToken(header.slice("Bearer ".length).trim()) !== undefined
  }
}
