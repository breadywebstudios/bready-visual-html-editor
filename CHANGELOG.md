# Changelog

## 1.3.0

- **PHP support.** `.php` and `.phtml` files open in the visual editor.
  - PHP code never runs. Blocks that print something show as small purple tags in the preview; the **PHP tags** toggle hides them.
  - `include` / `require` files such as `header.php` are pulled into the preview, so the page shows its full design. Click an included part to open that file.
  - Every PHP block stays exactly as written. Fields whose value contains PHP are read-only, and a text edit that would delete PHP code is refused.

## 1.2.0

- New **⟳ Reload** button that goes back to the last saved version of the file. It asks before discarding unsaved changes, which you can still bring back with Undo. It also refreshes the preview so CSS and image changes made elsewhere show up.

## 1.1.0

- New **Font** picker in the Style panel. It lists the fonts already used on the page, 28 popular Google Fonts and common system fonts, each previewed in its own typeface. You can also type any font name.
- Choosing a Google Font automatically adds its stylesheet `<link>` to the page's `<head>`, once per font, so it works on the live site too.

## 1.0.2

- README: added a how-to-use demo GIF.

## 1.0.1

- Fix: the page's CSS, images and fonts didn't load in the preview, so pages looked unstyled. Files are now sent to the preview in a format that VS Code can't corrupt.

## 1.0.0

- First release: visual editing of `.html` files with click-to-select, inline text editing, an element inspector (text, links, images, styles, attributes, raw HTML), add/move/duplicate/delete elements, page title & meta description, device preview widths, and two-way sync with the text editor.
