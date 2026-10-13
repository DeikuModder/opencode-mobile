<script lang="ts">
  /**
   * Login screen.
   *
   * The TOTP step is a separate view rather than extra fields on one form,
   * because the challenge only exists after the password is accepted and
   * showing an empty code field before that is misleading.
   */
  import { login } from "../lib/api.js"
  import { app } from "../lib/state.svelte.js"

  type Step = "password" | "totp"

  let step = $state<Step>("password")
  let username = $state("")
  let password = $state("")
  let code = $state("")
  let useRecovery = $state(false)
  let recovery = $state("")

  let busy = $state(false)
  let error = $state<string | null>(null)
  let hint = $state<string | null>(null)
  let lockedUntil = $state<number | null>(null)
  let lockTimer = $state<ReturnType<typeof setInterval> | null>(null)
  let codeInput = $state<HTMLInputElement | null>(null)

  const canSubmit = $derived(
    !busy &&
      (step === "password"
        ? username.trim().length > 0 && password.length > 0
        : useRecovery
          ? recovery.trim().length > 0
          : /^\d{6}$/.test(code.trim())),
  )

  function stopLockTimer() {
    if (lockTimer) {
      clearInterval(lockTimer)
      lockTimer = null
    }
  }

  function startLock(seconds: number) {
    stopLockTimer()
    lockedUntil = Date.now() + seconds * 1000
    lockTimer = setInterval(() => {
      if (Date.now() >= (lockedUntil ?? 0)) {
        lockedUntil = null
        stopLockTimer()
      }
    }, 250)
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit) return
    busy = true
    error = null
    hint = null
    try {
      const res = await login(
        username.trim(),
        password,
        step === "totp" && !useRecovery ? code.trim() : undefined,
        step === "totp" && useRecovery ? recovery.trim() : undefined,
      )

      if (res.ok) {
        // A 200 here means the session is established; the gateway set the
        // cookie and nothing else is needed on the client.
        await app.onLoggedIn()
        return
      }

      // The API has no `totp_required` code. When the password is right but no
      // code has been supplied yet it returns invalid_totp with
      // passwordAccepted:true, and that means "show me the second factor", not
      // "you failed". Waiting for a totp_required code that is never sent is why
      // this form used to loop on invalid_totp without ever revealing the field.
      if (res.passwordAccepted && step !== "totp") {
        hint = res.hint ?? null
        step = "totp"
        // Autofocus is what makes the numeric keypad appear immediately.
        requestAnimationFrame(() => codeInput?.focus())
        busy = false
        return
      }

      if (res.code === "totp_locked_out" && res.retryAfterSeconds) {
        startLock(res.retryAfterSeconds)
      }
      error = res.message
      busy = false
    } catch (e) {
      error = e instanceof Error ? e.message : "Login failed"
      busy = false
    }
  }

  function backToPassword() {
    step = "password"
    code = ""
    recovery = ""
    error = null
    hint = null
    stopLockTimer()
    lockedUntil = null
  }

  $effect(() => () => stopLockTimer())
</script>

<div class="wrap">
  <header>
    <h1>opencode</h1>
    <p class="faint">sign in</p>
  </header>

  {#if step === "password"}
    <form class="card col" onsubmit={submit}>
      <label>
        <span class="faint">username</span>
        <input
          bind:value={username}
          autocomplete="username"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          required
        />
      </label>
      <label>
        <span class="faint">password</span>
        <input
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
        />
      </label>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <button class="primary" type="submit" disabled={!canSubmit}>
        {#if busy}<span class="spinner"></span>{:else}continue{/if}
      </button>
    </form>
  {:else}
    <form class="card col" onsubmit={submit}>
      {#if hint}
        <p class="notice">{hint}</p>
      {/if}

      {#if useRecovery}
        <label>
          <span class="faint">recovery code</span>
          <input
            bind:value={recovery}
            autocomplete="one-time-code"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            required
          />
        </label>
      {:else}
        <label>
          <span class="faint">6-digit code</span>
          <!-- inputmode numeric gets the number pad without a visible spinner,
               and autocomplete one-time-code lets iOS offer the code from
               Messages or the authenticator app. -->
          <input
            bind:this={codeInput}
            bind:value={code}
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="6"
            autocomplete="one-time-code"
            required
          />
        </label>
        <button
          type="button"
          class="ghost"
          onclick={() => {
            useRecovery = !useRecovery
            code = ""
            recovery = ""
            error = null
          }}
        >
          {useRecovery ? "use authenticator code" : "use a recovery code"}
        </button>
      {/if}

      {#if lockedUntil}
        <p class="error" role="alert">
          too many attempts. wait {Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000))}s.
        </p>
      {:else if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <button class="primary" type="submit" disabled={!canSubmit || lockedUntil !== null}>
        {#if busy}<span class="spinner"></span>{:else}verify{/if}
      </button>
      <button type="button" class="ghost" onclick={backToPassword} disabled={busy}>back</button>
    </form>
  {/if}
</div>

<style>
  .wrap {
    max-width: 420px;
    margin: 0 auto;
    padding: calc(env(safe-area-inset-top) + 32px) 20px calc(env(safe-area-inset-bottom) + 32px);
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 20px;
  }
  header {
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  header p {
    margin: 4px 0 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  form button {
    width: 100%;
  }
</style>
