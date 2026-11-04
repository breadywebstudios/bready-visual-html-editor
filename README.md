# Bready Visual HTML Editor

Edit your HTML pages **visually**, right inside VS Code. Click anything on the page to select it, double-click text to type straight into it, and change links, images, colours and spacing from a side panel. Every change is written into your `.html` source file.

Only the part you changed is rewritten. Indentation, comments, quoting and everything else in the file stay exactly as they were, so your git diffs show just your real edits.

![Selecting, typing, styling and duplicating elements in the visual editor, then the saved changes in index.html](images/demo.gif)

## Features

- **Click to select, double-click to type.** Bold, italic, underline and links while you type.
- **Side panel** for the selected element:
  - text, link address and "open in new tab"
  - image file and alt text, plus **Replace image…**, which copies the picture into your project
  - colour, background, font size, weight, alignment, padding, margin, width and corner radius
  - id, classes and every other attribute
  - the element's own HTML, for quick code-level fixes
- **Move up / down, duplicate, delete**, or **add** headings, paragraphs, buttons, images, lists and sections.
- **Page settings:** page title and meta description (the Google snippet).
- **Desktop / Tablet / Mobile** preview widths.
- **Works with VS Code itself:**
  - undo/redo, the unsaved-changes dot, Save, git and Live Share all behave normally
  - edits made in the text editor show up in the visual view, and the other way round
  - selecting an element highlights its code in an open text editor
- **Your images, CSS and fonts load in the preview.** Files from your workspace are used, and CSS or image changes refresh it automatically.

## How to use

1. Open your website folder in VS Code (**File → Open Folder…**).
2. Open an `.html` file and click the **✎ Open in Visual Editor** button in the editor title bar. You can also right-click the file in the Explorer and choose **Open in Visual Editor**.
3. Click, double-click, edit. Use **</> Source** to open the code beside it.

To always open HTML files visually, right-click an `.html` file → **Open With…** → **Configure default editor for '\*.html'** → **Bready Visual HTML Editor**.

| Shortcut | Action |
|---|---|
| Double-click / Enter | Edit the selected element's text |
| Ctrl/Cmd + Enter | Finish editing text |
| Esc | Cancel text edit / deselect |
| Delete | Delete the selected element |
| Ctrl/Cmd + D | Duplicate the selected element |
| Ctrl/Cmd + Z / Shift+Z | Undo / redo |
| Ctrl/Cmd + S | Save |

## Settings

| Setting | Default | Description |
|---|---|---|
| `breadyVisualHtml.autoSave` | `true` | Save the file after every visual edit |
| `breadyVisualHtml.runScripts` | `false` | Run the page's own `<script>` tags in the preview |

## Good to know

- It edits the HTML that's **in the file**. Content created by JavaScript at runtime, and frameworks like React, Vue or Next.js, can't be edited visually.
- Style changes are saved as an inline `style=""` on that element. They are not written into your CSS file.
- Page scripts are off in the preview by default so the page stays still while you edit. Inline handlers such as `onclick="…"` never run in the preview.

---

Made by [Bready Web Studios](https://breadywebstudio.vercel.app) · Questions or ideas: breadywebstudios@gmail.com
