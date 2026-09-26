# Presenting on one screen

On Load, leave **Present to** set to **Automatic**. With one external display,
**Start Show** asks which loaded audience language to show. The selected language
fills that display; the operator controls remain on the computer screen.

Connect the display in extended-display mode, not mirroring. Dedicated stage
slides are not offered as audience languages. The chooser validates that the
screen is still connected before starting.

With multiple external displays, Automatic uses the saved screen setup. Choose
**One screen** to use just one of them; the language prompt also lets you choose
which display. Choose **Saved screen setup** to use the venue configuration
explicitly. These choices do not rewrite saved screen assignments or the
service's exceptional routing. **Test Output** keeps its separate demo behavior.

## Local Mac verification (Preview 36)

- 48 focused checks passed, covering both languages, native service and legacy
  slide routing, disconnected/operator-screen rejection, actual chooser
  submission, saved configuration isolation, and Test Output behavior.
- 237 JavaScript files passed syntax checks.
- Packaged service-core round trip and runtime smoke passed.
- Package signature and packaged source comparison passed.
- Installed app's Load controls and no-display guidance verified.
- Physical projection remains unverified in this change: no external display
  was connected during installation. No release installers were published.
