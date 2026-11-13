# Archived documents (legacy Python version)

This directory keeps the design and plan documents of the retired **Python + Tkinter**
implementation. They are historical evidence only, not the specification of the current
product:

- `superpowers/plans/2026-10-29-desktop-ux.md`
- `superpowers/specs/2026-10-29-desktop-ux-design.md`

The documents describe CustomTkinter/ttk screens, columns and behaviours that no longer
exist. The current behaviour contract lives in the root `README.md` and
`desktop/README.md`.

The legacy source code is preserved in Git history and in the backup branch
`backup/main-pre-ts-electron-20261113`, so no copy is kept here. To inspect a single old
file without switching branches:

```powershell
git show backup/main-pre-ts-electron-20261113:main.py
```
