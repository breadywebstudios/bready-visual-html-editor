# Changelog

## 1.1.0

- New **Font** picker in the Style panel. It lists the fonts already used on the page, 28 popular Google Fonts and common system fonts, each previewed in its own typeface. You can also type any font name.
- Choosing a Google Font automatically adds its stylesheet `<link>` to the page's `<head>`, once per font, so it works on the live site too.

## 1.0.2

- README: added a how-to-use demo GIF.

## 1.0.1

- Fix: the page's CSS, images and fonts didn't load in the preview, so pages looked unstyled. Files are now sent to the preview in a format that VS Code can't corrupt.

## 1.0.0

- First release: visual editing of `.html` files with click-to-select, inline text editing, an element inspector (text, links, images, styles, attributes, raw HTML), add/move/duplicate/delete elements, page title & meta description, device preview widths, and two-way sync with the text editor.
