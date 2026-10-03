# Render from the repo root: vhs assets/tapes/tree.tape
Output assets/tree.gif

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 430
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export PS1='> ' && clear"
Enter
Show

Type "bun examples/tree.ts examples/weather-station.md"
Sleep 300ms
Enter
Sleep 3s
Type "clear"
Enter
Type "bun examples/tree.ts examples/weather-station.md --thinning 120"
Sleep 300ms
Enter
Sleep 3.5s
