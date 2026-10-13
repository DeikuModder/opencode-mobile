import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { loadConfig, resolveDbPath } from "./config.js"
import { FixedWindowStore } from "./rate-limit.js"
import { openDb } from "./auth/db.js"
import { AuthService } from "./auth/service.js"
import { AuthController } from "./auth/auth.controller.js"
import { SessionGuard } from "./auth/session.guard.js"
import { OriginGuard } from "./auth/origin.guard.js"
import { RateLimitGuard } from "./rate-limit.guard.js"
import { APP_CONFIG, APP_ORIGIN, DB, RATE_LIMIT_STORE, SESSION_COOKIE, SESSION_POLICY } from "./tokens.js"
import { GatewayController } from "./gateway/gateway.controller.js"
import { ServeProxy } from "./gateway/serve-proxy.js"
import { EventHub } from "./gateway/event-hub.js"
import { ProjectRegistry } from "./projects/registry.js"
import { TelegramNotifier } from "./notifier/telegram.js"
import { EventPump } from "./notifier/event-pump.js"

@Global()
@Module({
  controllers: [AuthController, GatewayController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: APP_ORIGIN, useFactory: (c: ReturnType<typeof loadConfig>) => c.appOrigins, inject: [APP_CONFIG] },
    {
      provide: SESSION_COOKIE,
      useFactory: (c: ReturnType<typeof loadConfig>) => c.session.cookieName,
      inject: [APP_CONFIG],
    },
    {
      provide: SESSION_POLICY,
      useFactory: (c: ReturnType<typeof loadConfig>) => ({
        ttlMs: c.session.ttlMs,
        slideIntervalMs: c.session.slideIntervalMs,
      }),
      inject: [APP_CONFIG],
    },
    { provide: DB, useFactory: () => openDb(resolveDbPath()) },
    { provide: RATE_LIMIT_STORE, useFactory: () => new FixedWindowStore() },
    AuthService,
    SessionGuard,
    OriginGuard,
    RateLimitGuard,
    // Before ServeProxy and EventPump: both are consumers, and the hub owns the
    // one upstream event connection they share.
    EventHub,
    ServeProxy,
    ProjectRegistry,
    TelegramNotifier,
    EventPump,
    // Order matters: rate limiting and CSRF both run before authentication, so
    // a flood or a cross-site request never reaches the session lookup.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
  ],
})
export class AppModule {}
