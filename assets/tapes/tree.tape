# Render from the repo root: vhs assets/tapes/tree.tape
Output assets/tree.gif

Set Shell bash
Set FontSize 13
Set Width 1060
Set Height 940
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export PS1='> ' && clear"
Enter
Show

Type "bun examples/tree.ts"
Sleep 300ms
Enter
Sleep 4s
