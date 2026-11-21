# Speech test fixtures

- `hi_*.wav`, `ta_*.wav`, `te_*.wav`, `ml_*.wav`, `kn_*.wav` are short human recordings taken from the **FLEURS** dataset
  (Google, "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech"), test split, converted to
  16-bit WAV. Licence: **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). `manifest.json` holds the reference text.
- `en_*.wav` and `mix_*.wav` were generated with a Windows text-to-speech voice and contain only short application commands.

They are used only by `test_asr.js` to check on-device speech recognition against real speech.
