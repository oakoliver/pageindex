# Render from the repo root: vhs assets/tapes/cli.tape

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

Hide
Type "export PS1='> ' && clear"
Enter
Show

Type "bun src/cli.ts --md examples/sample-design-doc.md -o /tmp/design.json"
Sleep 300ms
Enter
Sleep 1.5s
Type "head -n 28 /tmp/design.json"
Sleep 300ms
Enter
Sleep 2s
Screenshot assets/cli.png
