# Publishing to the VS Code Marketplace

## 0. Try it locally first

In VS Code, open the Extensions view, click the **…** menu, choose **Install from VSIX…**, and pick `bready-visual-html-editor-1.0.0.vsix`. Then open a website folder, open an `.html` file and click the ✎ button in the editor title bar.

To work on the code itself, open this folder in VS Code and press **F5**. A second VS Code window opens with the extension loaded.

## 1. Create your publisher (one time)

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account. A personal Outlook/Hotmail account works, and you can create one free with your Gmail address.
2. Click **Create publisher**.
   - **ID:** `breadywebstudios`. This can never be changed. It must match `"publisher"` in `package.json`, so if the ID is taken, choose another one and update `package.json` to match.
   - **Name:** `Bready Web Studios`. This is what people see on the Marketplace.

## 2. Publish: the easy way (manual upload, no tokens)

1. Build the package: `npx @vscode/vsce package`. This creates the `.vsix` file.
2. On the **manage** page, click **+ New extension → Visual Studio Code** and upload the `.vsix`.
3. Wait a few minutes while it's scanned. It then appears at
   `https://marketplace.visualstudio.com/items?itemName=breadywebstudios.bready-visual-html-editor`

**To release an update:**
1. Bump `"version"` in `package.json`, for example from 1.0.0 to 1.0.1.
2. Add a line to `CHANGELOG.md`.
3. Package again.
4. On the manage page, click **⋯ → Update** and upload the new `.vsix`.

## 3. Publish from the command line (optional)

`vsce login` + `vsce publish` used an Azure DevOps Personal Access Token (Marketplace → Manage scope, "All accessible organizations"). Microsoft is **retiring those global tokens on 1 December 2026**. For automated publishing, the recommended route is a GitHub Actions workflow using Trusted Publishing:

1. Push this folder to a GitHub repo.
2. On the Marketplace manage page, add a Trusted Publishing policy for that repo.
3. Have the workflow run `npx @vscode/vsce publish --oidc`.

For a one-person extension, the manual upload in step 2 is simpler.

## 4. Before the first public release

- ✅ `"repository"` points at github.com/breadywebstudios/bready-visual-html-editor, so README images use relative paths (vsce turns them into GitHub links).
- ✅ Demo GIF (`images/demo.gif`) is at the top of the README. **Push to GitHub before publishing**, or the Marketplace page will show a broken image.
- `"icon"` must be a PNG of at least 128×128. `images/icon.png` is 256×256.
- Optionally publish to **Open VSX** (<https://open-vsx.org>) as well. Cursor, Windsurf and VSCodium install extensions from there, not from the Microsoft Marketplace. Sign in with GitHub, create the `breadywebstudios` namespace, then run `npx ovsx publish *.vsix -p <token>`.

## 5. Checklist

- [ ] Publisher ID matches `package.json`
- [ ] Version bumped and CHANGELOG updated
- [ ] Tested the `.vsix` via **Install from VSIX…**
- [ ] Pushed to GitHub (the README GIF is loaded from there)
