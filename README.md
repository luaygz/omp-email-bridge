# omp email bridge

An [omp](https://github.com/can1357/oh-my-pi) extension that gives every omp session its own email address, so you can keep working with a session from your phone or anywhere else you have email.

When you send the first prompt in a session, the session emails you from its own address, something like `k3j9x2mq4p@agents.example.com`. The email shows the working directory and a shortened copy of your prompt. Reply to it, or write a new email to that address later, and your message lands in that session as if you had typed it. The agent can also email you with an `email_user` tool, for example when it finishes a task. Your replies to those emails come back to the same session.

Email goes through [Mailtrap](https://mailtrap.io) on a domain you own. Only email from your own address with a valid DKIM signature is accepted, and email for one session never reaches another.

## How it works

- **Addresses.** A session's address is a hash of its session ID, so the session keeps its address when you close omp and resume it later. `/new` and forks get new addresses. Run `/email` in a session to see its address.
- **The session email.** After the first prompt you type in an interactive session, the bridge emails you. The subject names the project directory and the body has the full working directory and your prompt, shortened to about a paragraph (its start, then `...`, then its end). When you resume an older session, the email shows the prompt the session started with and the prompt you resumed it with.
- **Incoming email.** Each open session checks the Mailtrap inbox every 15 seconds for messages sent to its own address. Each message has to pass the sender checks. It then goes into the chat as your message, with a note that it came by email. If the agent is idle, this starts a turn; if it's busy, the email is steered into the running turn. Mail clients add a quoted copy of the email you're replying to; the bridge removes it.
- **Attachments.** These are saved to disk and the agent is told where. Images are also shown to the model directly.
- **Email you send while a session is closed** waits in Mailtrap and is delivered when you resume that session.
- **Agents emailing you.** The `email_user` tool sends from the session's address to you and nobody else. Subagents can't use it.

## What you need

- [omp](https://github.com/can1357/oh-my-pi) and [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
- A domain you own, and access to its DNS settings. A subdomain such as `agents.example.com` is enough.
- A Mailtrap account. The free plan is enough. At the time of writing it allows one sending domain, 150 emails a day and 4,000 a month, and the catch-all inbox works on it.
- An email account that DKIM-signs the mail it sends. Gmail, Outlook.com, iCloud Mail, Fastmail, Proton Mail and most other providers do.

## Setup

### 1. Get a domain

If you don't own a domain yet, buy one from any registrar, such as Cloudflare Registrar, Porkbun or Namecheap. A cheap one is fine.

Use a subdomain that does nothing else, such as `agents.example.com`. You'll point its MX record at Mailtrap, and an MX record decides where all email for that name goes. If you put it on a domain that already receives your email, for example `example.com` with Google Workspace, your normal email would go to Mailtrap instead. You don't create a subdomain anywhere separately; adding DNS records under its name is enough.

Mailtrap's free plan allows one sending domain. If your account already sends from another domain, remove it under **Domains** or upgrade before adding this one.

### 2. Create a Mailtrap account and an API token

1. Sign up at [mailtrap.io](https://mailtrap.io).
2. Open [Settings → API Tokens](https://mailtrap.io/settings/api-tokens) and click **Add Token**.
3. Name it (for example `omp email bridge`) and give it **Admin** access to your account.
4. Copy the token. The installer asks for it.

### 3. Run the installer

```sh
git clone https://github.com/luaygz/omp-email-bridge.git
cd omp-email-bridge
./install.sh
```

The installer asks for your API token (the input is hidden), your email address, and the domain to use. You can pick a domain already in your Mailtrap account or type a new one, which it adds for you. Then it:

1. checks that the domain is verified, and if it isn't, prints the DNS records to add and stops (see the next step);
2. turns on inbound email for the domain, and prints the MX record if that isn't in place yet;
3. finds the domain's catch-all inbox, or creates one (`*@agents.example.com`) in a Mailtrap inbound folder named `omp`;
4. saves the settings to `~/.omp/agent/.env`;
5. links `~/.omp/agent/extensions/email-bridge` to this checkout and installs its one dependency;
6. sends a test email from the domain to itself and waits for it to arrive, which proves that both sending and receiving work. Then it deletes the test email.

The installer saves what it learned before it stops, so run `./install.sh` again after each DNS change and it continues where it left off. Running it again on a finished setup is safe.

Because the extension is linked rather than copied, keep the clone where it is; `git pull` updates the installed extension. Options:

| Option | Effect |
| --- | --- |
| `--copy` | Copy the extension into omp instead of linking to the clone. |
| `--agent-dir DIR` | Use another omp agent directory, such as a profile's (`~/.omp/profiles/<name>/agent`). Defaults to `$PI_CODING_AGENT_DIR` or `~/.omp/agent`. |
| `--skip-test` | Don't send the test email. |

### 4. Add the DNS records

Mailtrap only sends and receives for a domain after the domain's DNS proves that you own it. The installer prints the records that are still missing. For `agents.example.com` they look like this:

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| CNAME | `mt51.agents.example.com` | `smtp.mailtrap.live` | Proves you own the domain. The `mt51` part differs per account; copy yours. |
| CNAME | `rwmt1._domainkey.agents.example.com` | `rwmt1.dkim.smtp.mailtrap.live` | DKIM key, so the email you're sent passes checks. |
| CNAME | `rwmt2._domainkey.agents.example.com` | `rwmt2.dkim.smtp.mailtrap.live` | Second DKIM key. |
| TXT | `_dmarc.agents.example.com` | `v=DMARC1; p=none; ...` (copy it whole) | DMARC policy. |
| CNAME | `mt-link.agents.example.com` | `t.mailtrap.live` | Link-tracking domain that Mailtrap requires. |
| MX, priority 10 | `agents.example.com` | `inbound.smtp.mailtrap.io` | Sends email for the domain to Mailtrap. |

Add them where your domain's DNS is hosted. That is usually your registrar, or Cloudflare if you moved the domain there. Things that often go wrong:

- **The Name field.** Most DNS providers want only the part before your root domain, for example `rwmt1._domainkey.agents` for the domain `example.com`, and add the rest themselves. If you paste the full name, you can end up with `rwmt1._domainkey.agents.example.com.example.com`.
- **Cloudflare.** Set every CNAME record to **DNS only** (grey cloud). Proxied CNAMEs break verification.
- **The MX record.** It only shows up in the installer after the other records verify, because Mailtrap enables receiving on verified domains only. You can save a round by adding it together with the others; the installer tells you if Mailtrap expects a different value.
- **Waiting.** DNS changes take from a few minutes to a day to show up. You can check from a terminal:

  ```sh
  dig +short CNAME rwmt1._domainkey.agents.example.com
  dig +short MX agents.example.com
  ```

- **Compliance review.** Mailtrap may review a new sending domain and ask for details about you or your use. Finish anything it asks for in the Mailtrap dashboard. Until then, sending can be held back.

When the records are in place, run `./install.sh` again.

### 5. Start using it

Restart omp. In a session:

1. Run `/email` to see the session's address and confirm the bridge is working.
2. Send a prompt. A minute later you should have an email from the session.
3. Reply to it from your phone. The reply shows up in the session within about 15 seconds.

To make agents send email through the bridge, for example completion notices, add a line like this to `~/.omp/agent/AGENTS.md`:

```md
Send every email to me with the `email_user` tool. Replies to those emails come back into the session.
```

## Manual setup

If you'd rather not run the installer, these are the same steps by hand.

1. **Add the domain.** In Mailtrap, click **Domains** in the left menu (the page is titled Sending Domains), click **Add Domain**, and enter your domain. Mailtrap then shows the domain's **Domain Verification** page with the DNS records to add; add them as described in [step 4](#4-add-the-dns-records). Mailtrap re-checks the records every hour, or right away when you click **Re-check DNS Records**. Once they verify, it asks for sender information and runs a compliance check. The domain is ready when the Domains page shows it as **Verified**. On the free plan, **Add Domain** is greyed out once you have one domain.
2. **Turn on receiving.** Click the domain on the Domains page. On its **Domain Verification** page, under **Add DNS records to your domain provider**, turn on **Inbound domain receiving**, then add the MX record it shows (`agents.example.com`, MX, priority 10, `inbound.smtp.mailtrap.io`).
3. **Create the catch-all inbox.** Mailtrap's documentation creates inbound inboxes through its API, so this step uses `curl`. The first two lines ask for your token without echoing it and define a small `mt` helper that hands the token to `curl` on stdin, so it never lands in your shell history or in the process list. Replace the `<...>` parts with the IDs printed by the earlier commands:

   ```sh
   printf 'Mailtrap API token: '; read -rs MAILTRAP_API_TOKEN; echo
   mt() { printf 'Authorization: Bearer %s\n' "$MAILTRAP_API_TOKEN" | curl -s -H @- "$@"; echo; }

   # Your account ID: the "id" in the reply.
   mt https://mailtrap.io/api/accounts

   # Your domain ID: the "id" next to your domain's "domain_name".
   mt https://mailtrap.io/api/accounts/<account id>/sending_domains

   # A folder for the inbox: note its "id".
   mt -X POST https://mailtrap.io/api/inbound/folders \
     -H "Content-Type: application/json" -d '{"name": "omp"}'

   # The catch-all inbox on your domain.
   mt -X POST https://mailtrap.io/api/inbound/folders/<folder id>/inboxes \
     -H "Content-Type: application/json" -d '{"name": "omp sessions", "domain_id": <domain id>}'

   unset MAILTRAP_API_TOKEN
   ```

   The last reply looks like `{"id": 3333, "name": "omp sessions", "address": "*@agents.example.com", "domain_id": 1111111}`. Its `id` is your `OMP_EMAIL_INBOX_ID`. If the address isn't `*@` followed by your domain, the domain ID was wrong or inbound receiving isn't on yet. The [Mailtrap CLI](https://github.com/mailtrap/mailtrap-cli) can do the same with `mailtrap-cli inbound folders create` and `mailtrap-cli inbound inboxes create --domain-id`.
4. **Install the extension** from the clone:

   ```sh
   bun install --production
   ln -s "$PWD" ~/.omp/agent/extensions/email-bridge
   ```

5. **Add the settings.** Copy the lines from [`.env.template`](.env.template) into `~/.omp/agent/.env` and fill them in.

## Settings

The bridge reads these from the environment first, then from the `.env` file in your omp agent directory (`~/.omp/agent/.env`). See [`.env.template`](.env.template).

| Setting | Meaning |
| --- | --- |
| `MAILTRAP_API_TOKEN` | Mailtrap API token with admin access to your account. |
| `OMP_EMAIL_OWNER` | Your email address. Sessions email you here, and only accept email sent from it. |
| `OMP_EMAIL_DOMAIN` | The Mailtrap domain sessions send from and receive on. |
| `OMP_EMAIL_INBOX_ID` | ID of the catch-all inbound inbox for that domain. |
| `OMP_EMAIL_POLL_SECONDS` | Optional. Seconds between inbox checks, default 15, minimum 5. |

If a required setting is missing, omp shows a warning when it starts and the bridge stays off.

## Details

- **Where it runs.** Only interactive (TUI) main sessions check the inbox and send the session email. Print-mode runs (`omp -p`) can send email with the tool but never receive any.
- **Which prompts count.** The session email goes out after the first prompt you send. Commands such as `/email` and messages that arrive by email don't trigger it. If Mailtrap rejects the send, the next prompt tries again. If it's unclear whether the email went out, the bridge doesn't retry, so you never get duplicates.
- **Attachments.** They're saved under `~/.omp/agent/email-bridge/attachments/<session>/<message>/`. Images up to 5 MB are also shown to the model. Files over 25 MB are skipped and listed as skipped.
- **Delivery bookkeeping.** Each session records the messages it has handled in `~/.omp/agent/email-bridge/sessions/`, so nothing is delivered twice. An email only counts as delivered once it appears in the session's history. If omp closes, or you switch sessions, while an email is still waiting in omp's queue, it is delivered again the next time that session is open.
- **The same session in two omp windows.** Only one of them delivers its email, controlled by a lock file in `~/.omp/agent/email-bridge/locks/`.
- **Mailtrap keeps a copy.** Messages stay in the Mailtrap inbox as a record. The bridge never deletes them.

## Security

Anyone can send email to any address on your domain. The bridge delivers a message only if all of these hold:

- it has exactly one From address, and that address is `OMP_EMAIL_OWNER`;
- it has a passing DKIM signature from your email provider's domain (aligned with the From domain under DMARC's relaxed rule) that covers the whole message body;
- the session's address is in a To or Cc header that the same signature covers. A To or Cc header added outside the signature doesn't count, and Bcc'd copies are rejected for the same reason.

Email that fails any check is not delivered, and the session shows a warning saying why.

An accepted email becomes a prompt to an agent that can run commands on your computer. That makes your email account a remote control for your machine, so protect it with two-factor authentication. Session addresses appear in ordinary email headers, so don't treat them as secrets.

DKIM keys are looked up over DNS-over-HTTPS (Cloudflare, then Google). Bun's built-in DNS resolver splits long DKIM records into pieces, which makes every signature check fail. The installer writes the `.env` file with permissions `600`, and the API token is never logged or printed.

## Troubleshooting

- **"Email bridge is off: ..." when omp starts.** A setting is missing or invalid. The message names it.
- **No session email.** It only goes out from interactive sessions, after the first prompt you type. `/email` shows the last error. If you just changed settings, restart omp.
- **Replies don't show up.**
  - Check that the MX record points to Mailtrap (`dig +short MX agents.example.com`) and that the email reached the inbox in the Mailtrap dashboard.
  - The session shows a warning if it rejected the message.
  - Email forwarded through another account, or sent from an alias, usually fails the DKIM or sender check.
- **"Another omp process is delivering this session's email".** The same session is open in another omp window. That window delivers its email.
- **The installer's test email never arrives.** Usually the MX record is missing or hasn't spread yet.

## Uninstall

```sh
rm ~/.omp/agent/extensions/email-bridge     # the link (or the copied folder)
rm -rf ~/.omp/agent/email-bridge            # per-session state and saved attachments
```

Then remove the `OMP_EMAIL_*` lines, and the token if nothing else uses it, from `~/.omp/agent/.env`. The Mailtrap domain and inbox stay until you delete them in Mailtrap.

## Development

```sh
bun install       # also installs omp's types
bun run check     # type-check
```

| File | Contents |
| --- | --- |
| `index.ts` | The extension: session addresses, the session email, the `email_user` tool, the `/email` command, inbox polling and delivery. |
| `config.ts` | Settings from the environment and `.env`. |
| `mailtrap.ts` | Mailtrap API client. |
| `verify.ts` | Sender and DKIM checks. |
| `text.ts` | Quoted-reply stripping, prompt shortening, address parsing. |
| `state.ts` | Per-session state and mailbox locks. |
| `scripts/install.ts` | The installer (`install.sh` runs it with Bun). |

## License

[MIT](LICENSE)
