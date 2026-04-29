# Publishing Guide

Steps to publish `deepseek-v4-vscode-chat` to the VS Code Marketplace, Open VSX, and GitHub Releases. Follow this guide step by step on the first release.

---

## One-time setup

### 1. GitHub repository

Make sure the code is pushed to `https://github.com/Laurent00TT/deepseek-v4-vscode-chat` (this is the URL in `package.json`). If your GitHub username is different, or you want a different repo name, update `repository.url`, `bugs.url`, `homepage`, and `author.url` in `package.json` first.

If your local `origin` still points at the legacy fork name (`huggingface-vscode-chat`):

```bash
# Rename the repo on GitHub to deepseek-v4-vscode-chat,
# then update origin locally:
git remote set-url origin https://github.com/Laurent00TT/deepseek-v4-vscode-chat.git
git remote -v   # verify
```

### 2. VS Code Marketplace publisher

You already have publisher `Laurent00TT` registered. Now generate a **Personal Access Token (PAT)** for `vsce` to use.

#### Create an Azure DevOps Personal Access Token

1. Go to <https://dev.azure.com/> (sign in with the same Microsoft account that owns the publisher).
2. Top-right avatar → **User settings** → **Personal access tokens**.
3. **+ New Token**:
   - **Name**: `vsce-deepseek-v4-publish` (any label).
   - **Organization**: **All accessible organizations** — this matters; leaving it on a single org is the most common cause of 401 errors during publish.
   - **Expiration**: 90 days or 1 year, your choice.
   - **Scopes**: click **Custom defined** → find **Marketplace** → check **Manage**.
4. Copy the token string immediately and store it somewhere safe; it is shown only once.

That PAT is reusable for every release until it expires. When it does, generate a new one and update the corresponding GitHub secret.

### 3. Open VSX (optional, for VSCodium / Cursor / Windsurf users)

1. Sign in at <https://open-vsx.org/> with GitHub.
2. Top-right → **Settings** → **Access Tokens** → **Generate new token**.
3. Copy the token.

Before the first publish, claim the publisher namespace:

```bash
npx ovsx create-namespace Laurent00TT --pat <your-ovsx-token>
```

### 4. Add tokens as GitHub Actions secrets

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value | Used by |
| ------ | ------ | ------ |
| `MARKETPLACE_TOKEN` | the Azure DevOps PAT | VS Code Marketplace publish |
| `OPEN_VSX_TOKEN` | the Open VSX PAT | Open VSX publish (optional) |

`GITHUB_TOKEN` is provided automatically by Actions; you do not need to add it.

---

## Releasing a new version

### 1. Sync your branch

```bash
git checkout main
git pull
npm install
npm run compile
npm run lint
```

### 2. Bump the version

Follow [SemVer](https://semver.org/):

- bug fix → patch (`0.3.0` → `0.3.1`)
- new feature → minor (`0.3.0` → `0.4.0`)
- breaking change → major (`0.3.0` → `1.0.0`)

```bash
npm version patch    # or minor / major
```

This automatically:

- updates `version` in `package.json`
- creates a commit with the new version
- creates a git tag `v0.3.0`

### 3. Update the CHANGELOG

Move the items currently grouped above the latest released version (under the `[released]` banner) into the new version heading, add a date, then amend:

```bash
# Edit CHANGELOG.md, then
git add CHANGELOG.md
git commit --amend --no-edit
git tag -f v0.3.0
```

### 4. Local sanity check (recommended)

```bash
npm run package   # runs vsce package
```

You should get a `deepseek-v4-vscode-chat-0.3.0.vsix`. Inspect it:

- File size should be small (tens of KB). If it is megabytes, something leaked through `.vscodeignore`.
- `unzip -l deepseek-v4-vscode-chat-0.3.0.vsix` to list contents — there should be no `src/`, `node_modules/`, or `*.ts` files.

Install it locally to smoke-test:

```bash
code --install-extension deepseek-v4-vscode-chat-0.3.0.vsix
```

### 5. Push and let CI publish

```bash
git push origin main
git push origin v0.3.0
```

Pushing the tag triggers `.github/workflows/release.yml`:

1. **package** — re-compiles, lints, builds the VSIX as a CI artifact.
2. **publish-marketplace** — uses `MARKETPLACE_TOKEN` to publish to the VS Code Marketplace.
3. **publish-openvsx** — uses `OPEN_VSX_TOKEN` to publish to Open VSX.
4. **github-release** — creates a GitHub Release with auto-generated notes and attaches the VSIX.

Each publish job is independent; if one fails (e.g. you forgot the Open VSX token), the others still go through.

### 6. Verify

- VS Code Marketplace: <https://marketplace.visualstudio.com/items?itemName=Laurent00TT.deepseek-v4-vscode-chat> (visible 2–5 minutes after publish)
- Open VSX: <https://open-vsx.org/extension/Laurent00TT/deepseek-v4-vscode-chat> (almost instant)
- GitHub Release: <https://github.com/Laurent00TT/deepseek-v4-vscode-chat/releases>

---

## Manual publish (without CI)

If CI is broken or you want to publish locally:

```bash
# Marketplace
export VSCE_PAT=<your-marketplace-pat>
npm run package
npx @vscode/vsce publish --packagePath ./deepseek-v4-vscode-chat-0.3.0.vsix

# Open VSX
export OVSX_PAT=<your-openvsx-pat>
npx ovsx publish ./deepseek-v4-vscode-chat-0.3.0.vsix --pat "$OVSX_PAT"
```

---

## Unpublishing a version

The VS Code Marketplace **does not allow deleting a single version**; you can only unpublish an entire extension. If you ship a broken release:

1. Immediately publish a fixed version (`0.3.0` is broken → publish `0.3.1`).
2. Auto-update will skip the bad one for users.

To deprecate a single bad version so VS Code stops serving it:

```bash
npx @vscode/vsce unpublish Laurent00TT.deepseek-v4-vscode-chat 0.3.0
```

This is irreversible — use sparingly.

---

## Troubleshooting

### `vsce publish` returns 401 / 403

The most common cause is that the Azure DevOps PAT was created with a single Organization instead of **All accessible organizations**. Generate a new PAT and pick that option.

### `vsce package` reports "missing icon"

Check that `assets/icon.png` exists and that `package.json` `icon` field points at it. The Marketplace requires PNG (SVG is not accepted); 128×128 or 256×256 is recommended.

### `vsce package` warns about relative links in README

If your README contains links like `./LICENSE`, `vsce` requires the `repository.url` field so the Marketplace can resolve them to absolute URLs. We have it set, so this should not occur.

### Open VSX publish fails because the namespace does not exist

Run `npx ovsx create-namespace Laurent00TT --pat <token>` once before the first publish. See the one-time setup section.

### How to monitor installs / ratings

Available a few hours after publish on the Marketplace listing page. The Action turning green does not mean the extension is immediately visible — Marketplace scanning typically takes 2–5 minutes.

---

## Release checklist

- [ ] `npm run compile` passes
- [ ] `npm run lint` passes
- [ ] `CHANGELOG.md` has a new section with the right date
- [ ] `package.json` `version` matches the git tag (`v0.3.0` ↔ `0.3.0`)
- [ ] `npm run package` produces a sane-sized `.vsix`
- [ ] Local `code --install-extension *.vsix` works end-to-end
- [ ] `git push` for both branch and tag, CI is green
- [ ] Marketplace listing shows the new version within a few minutes
- [ ] Open VSX listing shows the new version
- [ ] GitHub Release exists with the VSIX attached
