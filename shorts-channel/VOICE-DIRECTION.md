# Lesser Pemberton: Voice Direction Bible

Researched and written 23 November 2026. The settings below are the ones used to make `renders/short01-barry.mp4`, and the code that applied them is `workshop/video/build_audio.py`. Treat every number as a starting point to test by ear, not a universal optimum.

**Limitation you should know about:** I generated, edited and mixed this voice track but could not listen to it. Nothing in this environment plays audio, and the speech-to-text check I tried to run was blocked by the network. Everything below about how the voices *sound* in this render is untested until you listen. Score the track with section 12 on headphones and on a phone speaker before you publish.

---

## 1. Why AI voices sound artificial

### A. Rhythm and pacing

| Problem | What human speech does instead | Fix |
|---|---|---|
| Same speed throughout | People speed up through things they consider obvious and slow down on the thing they care about | Generate each phrase as its own chunk with its own `speed`. Deb's "Barry's been with us," is 0.92 and "eleven years." is 0.86 |
| Equal pauses between sentences | Pauses are as long as the thought needs: 80 ms between dictated words, 600 ms before a stubborn conclusion | Set every gap in the edit (`gap_after` per chunk), never let the model decide |
| No hesitation | People hesitate before words that cost them something | Put the pause *before* the costly word: "You can just... [400 ms] drive on it now." |
| Same cadence on every sentence | Each sentence has a different job: a question, a list, a verdict | Rewrite so consecutive lines differ in length. One-word lines ("Caps.") break the pattern |
| Pauses in grammatically wrong places | Breath pauses fall at phrase boundaries | Split chunks only at phrase boundaries. Never split inside "a candle line" |
| Every word equally weighted | One or two words per line carry the meaning | Decide the stressed word before generating (marked **bold** in the scripts below). Get the stress by giving that word its own chunk, a shorter preceding gap, or a rewrite that ends on it |
| Too fast or too slow overall | Comedy runs at roughly 160 to 190 words per minute, with silences | Start at speed 1.0 and move in 0.04 steps. Over 1.2 or under 0.8, Kokoro voices start to smear or drag |
| No change of speed during emotion | Panic speeds up, grief slows down, a pitch speeds up until the number | Marcus's list runs at 1.16 because he is selling. Deb's grief runs at 0.86 to 0.92 |

### B. Emotion

Emotion labels ("say this angrily") do little on their own. Performance comes from **intention**: what the character wants from the other person in this line. Each cue in `build_audio.py` carries an `intent` field for that reason.

The same line, *"I fixed it."*, delivered ten ways:

| State | Stress | Speed | Pause | Pitch movement | Rewrite that helps TTS |
|---|---|---|---|---|---|
| Confident | **fixed** | 1.0 | none | falls at the end | "I fixed it." |
| Nervous | **it** | 1.1 then 0.9 | before "it" | rises at the end | "I fixed... it?" |
| Annoyed | **I** | 0.95 | 200 ms after "I" | flat, clipped | "*I* fixed it. Me." |
| Confused | **fixed** | 0.9 | before "fixed" | rises | "I... fixed it? I think?" |
| Sarcastic | **fixed** | 0.85 | 300 ms before | over-wide, slow | "Oh, I *fixed* it." |
| Embarrassed | none | 1.15, trailing off | none | falls, quiet | "I fixed it, kind of, it's fine." |
| Excited | **fixed** | 1.15 | none | high, then up | "I fixed it! It works!" |
| Exhausted | **it** | 0.8 | 500 ms mid-line | flat and low | "I fixed. It." |
| Pretending to be clever | **fixed** | 0.95 | 200 ms before | measured | "Technically, I fixed it." |
| Hiding a lie | **fixed** | 1.1 | none, too smooth | too even | "Yeah, no, I fixed it, it's fixed." |

You'll notice half the fixes are rewrites. With Kokoro, which has no emotion control, the text is your strongest emotion control.

### C. Pronunciation

| Problem | Fix |
|---|---|
| Names said wrongly ("Pemberton" stressed oddly) | Respell phonetically in the TTS text only: "PEM-ber-tun". Keep the caption spelled correctly |
| Numbers read as digits | Write them as speech: "nineteen eighty-seven", then show "1987" in the caption (the `CAPFIX` table does this) |
| Abbreviations | Write what the character actually says: "TV" becomes "tee vee"; "LP" becomes "ell pee" |
| Overly crisp consonants | Use contractions and shorter words. "It is a hole" sounds read; "It's a hole" sounds said |
| Slang read robotically | Spell how it's said ("gonna", "y'know"), at most once per Short per character |
| Punctuation treated literally | Use full stops and commas only. Kokoro reads ellipses as a hesitation. Avoid em dashes, brackets and asterisks in TTS text |

Kokoro has no SSML. Google Cloud and Azure do: `<sub alias="Pemberton">Pmbrtn</sub>`, `<phoneme>` and `<say-as interpret-as="date">`. On those platforms, keep a pronunciation lexicon file per channel.

### D. Voice texture

| Sounds like | Usually comes from | Fix |
|---|---|---|
| Plastic, too smooth | The model (most neural voices are trained on clean studio reads) | Different voice, or a blend (see section 4). Don't add noise |
| Metallic, phasey | Processing: pitch shifting beyond ±2 semitones, or too much noise reduction | Keep rubberband pitch within ±1.5 semitones with `formant=preserved`. Never denoise TTS output; it has no noise |
| Hollow, distant | Low-mid scoop, or reverb added to dry TTS | Don't scoop below 250 Hz by more than 2 dB. Reverb only to match a location, and very little of it |
| Nasal | 800 Hz to 1.5 kHz build-up in the voice preset | EQ cut of 2 to 3 dB around 1 kHz, Q of 1.5, only on that character |
| Monotonous | Generation (one long chunk) | Generate shorter chunks with different speeds |
| Customer-service chatbot | Script (polite, complete sentences) plus a bright preset voice | Rewrite: shorter, ruder, interrupted. Choose a lower-energy voice |
| Too consistent | Every take identical | Generate 2 to 3 takes per line on platforms with randomness (temperature or seed) and pick. Kokoro is deterministic, so vary speed by ±0.02 to get a different take |

### E. Conversation

Real conversation has interruptions, reactions, misunderstandings and silences. Write those into the script, because the TTS will never invent them:

- Someone cuts in before the other person finishes (Priya over Marcus at −300 ms).
- One character answers a different question from the one that was asked.
- One character doesn't answer at all, and the silence is the reply (1.9 s after "drive on it now").
- Lines lose their endings ("a podcast--").

---

## 2. The biggest mistakes

| # | Problem | Why it happens | How to recognise it | Exact fix | Prevention | Rank |
|---|---|---|---|---|---|---|
| 1 | Whole scene generated in one pass | Fastest workflow | Everyone has the same energy, and the gaps are identical | Line-by-line or chunk-by-chunk generation | Script table with one row per chunk | Critical |
| 2 | Lines written for reading | Writers write prose | Sounds like an audiobook | Contractions, fragments, cut 30% | Read every line aloud before generating | Critical |
| 3 | Same voice preset for two characters | Small voice library | Viewers can't tell who's talking | Unique blend per character | Cast list with blends locked | Critical |
| 4 | Mispronounced name | Model has never seen the word | The name sounds different each time | Phonetic respelling | Pronunciation table per channel | Critical |
| 5 | Clipping or distortion | Gain stacked on stems | Crackle on loud lines | Peak limit at -1 dBTP | Loudness pass on every export | Critical |
| 6 | Unlicensed voice | Free tier without commercial rights | Not audible, but a legal risk | Use Apache or MIT models, or a paid plan | Licence log | Critical |
| 7 | Even pause lengths | Model default | Metronomic rhythm | Set gaps per chunk | Gap column in the script | High |
| 8 | No stress plan | Nobody decided | Every word flat | Mark one stressed word per line | Bold in the script | High |
| 9 | Punchline delivered at the same energy as the setup | Single-pass generation | The joke doesn't land | Separate chunk, slower speed, a pause before it | Punchline marked as its own row | High |
| 10 | Shouting as the default comedy setting | It feels funny to write | Fatiguing, unclear | Shout once per Short, maximum | Energy map per scene | High |
| 11 | No interruptions | Turn-taking scripts | Polite, unreal dialogue | Overlap 150 to 300 ms and duck the first line 4 to 6 dB | `//` marker in scripts | High |
| 12 | Music under dialogue | Fear of silence | Words are hard to hear on a phone | Music only between lines | Stings only | High |
| 13 | Over-compression | Chasing loudness | Breathless, flat, pumping | Ratio 2 to 3:1, -20 dB threshold | One compressor on the master | High |
| 14 | Pitch shifted too far | Trying to make a voice unique | Metallic, chipmunk | Stay within ±1.5 st, use blends instead | Blend first, shift second | High |
| 15 | Emotion label without intention | "Make it angry" | Generic anger | Write what the character wants | `intent` field per line | High |
| 16 | Long lines | Writer packs in exposition | Mid-line energy collapse | Split under 12 words | Word cap per line | High |
| 17 | Silence trimmed out | Editors hate dead air | Jokes rush | Keep 0.8 to 2 s silences on purpose | Silence written into the script | High |
| 18 | Digital silence between lines | Clean edit | Lines float in a vacuum | Room tone at about -46 dBFS | Room-tone bed per location | Medium |
| 19 | Harsh sibilance | Bright presets plus EQ boost | "S" sounds hiss on phones | De-esser at 5 to 8 kHz, gentle | No boosts above 6 kHz | Medium |
| 20 | Muddy low end | Proximity in the preset | Dull on laptop speakers | High-pass at 70 to 90 Hz, -2 dB at 250 Hz | Master chain template | Medium |
| 21 | Volume jumps between characters | Presets mastered differently | Riding the volume control | Per-character gain offsets (`gain_db`) | Match RMS before mixing | Medium |
| 22 | Reaction sounds missing | Only scripted lines generated | People react to nothing | Breaths, "hm", a laugh, only where motivated | Reaction column | Medium |
| 23 | Overused fillers | Trying to sound human | "Um, like, um" | Maximum one filler per character per Short | Filler quota | Medium |
| 24 | Fake stutters | Same reason | Sounds like a glitch | Remove, use a pause instead | Rule: a stutter needs a reason | Medium |
| 25 | Number or date read wrongly | Text normalisation | "one nine eight seven" | Write as words | Caption override table | Medium |
| 26 | Laugh generated by TTS | Tags like [laugh] | Canned, identical laughs | Record yourself or cut the laugh | One real laugh per character, reused sparingly | Medium |
| 27 | Reverb on dry TTS | Trying to place it in a room | Washy, distant | Tiny room only for scene contrast | Default dry | Medium |
| 28 | Voice drift between episodes | Re-cast or new version | Character sounds different | Lock blend weights and model version | `CAST` table in code | Medium |
| 29 | Breath sounds cleaned away | Over-editing | Breathless, unnatural | Leave natural ones in | Don't gate | Low |
| 30 | Final listen only on headphones | Habit | Phone-speaker problems slip through | Check on a phone speaker | QC step 13 | Low |
| 31 | Every line ends on a falling pitch | Model default | Monotonous sentence endings | Rewrite some lines as questions or unfinished thoughts | Vary line types | Low |

**The five that matter most** (fix these first and most of the "AI voice" feeling goes): 1, 2, 7, 9 and 3.

---

## 3. Making it natural

### A. Rhythm, bad vs better

| Bad | Better | Why |
|---|---|---|
| "I cannot believe you have done this." | "You did *what*." | Shorter, ends on the stressed word |
| "That is a terrible idea and I do not support it." | "No. (beat) Absolutely not. (beat) Who signed off on this?" | Three rhythms instead of one |
| "Well, I suppose the road crew will be arriving on Thursday." | "Okay so. Road crew. Thursday." | Fragments = urgency |
| "In 1987 they filled the quarry and it was never the same again and I will not move." | "In nineteen eighty-seven, they filled the quarry. (600 ms) Never the same. (400 ms) Gord's not moving." | The pauses carry the stubbornness |

### B. Intention per line (fill this in before generating)

| Field | Example: Priya, "You can just... drive on it now." |
|---|---|
| Feeling | Mild confusion, slight boredom |
| Wants | For everyone to notice the obvious so she can leave |
| Communicating | The problem is solved |
| Hiding | That she finds them a little endearing |
| Intensity | 2 out of 10 |
| Delivery | Quiet, flat, unhurried |
| Stress | **drive** |
| Pause | 400 ms after "just" |

### C. Imperfections, only with a reason

| Imperfection | When it's justified | Example |
|---|---|---|
| Hesitation | Saying something that costs the character | Priya before "drive on it now" |
| Self-correction | The character changes their mind or gets caught | "Thirty-nine. One was a draft." |
| Unfinished thought | Someone interrupts, or the speaker gives up | "a podcast--" |
| Sigh or breath | A real effort or a real feeling | Gord before a tangent |
| Energy change | The emotion changes mid-scene | Deb's grief turns into a scream |

### D. Comedy delivery

Shouting is rarely funny on its own: it flattens contrast, tires the ear and covers the words. Volume works as a *change*. One shout after quiet lines ("BARRY!") lands because everything around it is calm.

Ten identical lines, different delivery:

| Line | Weak delivery | Stronger delivery | Why the second is funnier |
|---|---|---|---|
| "It's a hole." | Exasperated, loud | Flat, quiet, not looking up | Understatement against Marcus's hype |
| "Barry is a brand." | Normal | Overconfident, slow, a pause before "brand" | Confident stupidity |
| "Never the same." | Sad, slow | Short, final, no pause after | The non-sequitur lands harder when Gord treats it as obvious |
| "Pleased to announce..." | Excited | Bright and professional while announcing nonsense | Fake seriousness |
| "Is that a lot?" | Concerned | Genuinely curious, slow | A delayed reaction from Gord |
| "Thirty-nine. One was a draft." | Defensive | Instant, proud | A correction that makes it worse |
| "It's my hand." | Shouted | Quietly baffled | Casual response to an absurd situation |
| "You had me sign it at a FUNERAL." | Shouted throughout | Controlled, then one word hit | Controlled frustration |
| "Worth it." | Happy | After a long beat, resigned | The delay is the joke |
| "...no." | Normal | A whisper after a held silence | The quiet punchline |

---

## 4. Character voice profiles

The way to make voices distinct is rhythm, articulation, energy and word choice first, and pitch last. Two of these cast members are female voices in a similar register (Deb and Wendy), and they stay distinct because Deb is fast and choppy while Wendy is measured and lands every sentence.

| | Deb | Marcus | Priya | Gord | Wendy |
|---|---|---|---|---|---|
| Identity | Alarmed neighbour, always on | Founder in a garage | Bored, sharp student | Retired, stubborn, warm | Acting mayor, permanently on camera |
| Vocal age impression | 50s | early 30s | about 19 | late 60s | mid 40s |
| Register / pitch range | Mid-high, wide range, jumps up on complaints | Mid, moderate range, rises on pitches | Low-mid, narrow, nearly flat | Low, narrow, drops at line ends | Mid, controlled range, bright lift on announcements |
| Resonance | Forward, a bit nasal | Chesty when confident | Close, quiet | Chest, gravelly | Head and mask, projected |
| Texture | Slightly breathless | Smooth, salesy | Soft, slightly airy | Grainy, warm | Polished |
| Speed | Fast (1.10 to 1.20) except in grief | Fast when selling (1.04 to 1.16) | Slow (0.88 to 0.92) | Slow (0.80 to 0.92) | Medium (1.0) |
| Accent | American suburban | American | American | Light British (from the voice blend) | American |
| Pronunciation habits | Says punctuation aloud. Hard consonants on caps words | Startup jargon, a little wrong | Clipped. Drops sentence endings | Says years in full. Names apps by colour | Crisp, every word finished |
| Sentence rhythm | Short bursts, dictation | Lists that build | 2 to 6 words | Long, then dead stop | Soundbite, pause, soundbite |
| Emotional range | Panic to grief to fury | Hype to mild offence | Boredom to rare surprise | Content to stubborn | Bright to brighter |
| Typical reaction | Gasp, then a post | "heh, okay, okay" | Silence | A tangent | Applauds herself |
| Laugh | Sharp, short | Self-satisfied chuckle | Exhale through the nose | Wheeze | Practised, 2 beats |
| Breath and pauses | Breathes mid-sentence when upset | Barely pauses | Long pause before speaking | Long pauses mid-sentence | Pauses for applause |
| Signature delivery | "Okay so." | "Respectfully," | "it's a hole." | "Gord's not moving." | "Pleased to announce" |
| Recognisable by | Choppy rhythm | Acceleration | Flatness | Slowness | Polish |
| **Kokoro blend** | af_sarah 0.6 + af_bella 0.4 | am_puck 0.65 + am_liam 0.35 | af_nicole 0.6 + af_river 0.4 | bm_george 0.75 + bm_lewis 0.25 | af_kore 0.6 + af_heart 0.4 |
| Pitch shift | +0.5 st | 0 | −1.0 st | −1.5 st | +0.3 st |
| Gain offset | 0 dB | −0.5 dB | +1.0 dB | 0 dB | −0.5 dB |

Lenny never speaks.

---

## 5. TTS settings: what exists where

| Control | Kokoro (local) | Zonos (local) | Dia (local) | Google Cloud TTS | Azure Speech | ElevenLabs (paid) |
|---|---|---|---|---|---|---|
| Speed | `speed` (default 1.0) | Speaking rate 5 to 30 (default 15) | Speed factor in demo | SSML `prosody rate` | SSML `prosody rate` | Speed slider |
| Pitch | No (post-process) | Pitch variation 0 to 300 | No | SSML `prosody pitch` (not on Chirp 3 HD) | SSML `prosody pitch` | No |
| Emotion | No | 8 emotion sliders 0 to 1 | Non-verbal tags | No | `mstts:express-as` style + `styledegree` on some voices | Audio tags on v3 |
| Stability / temperature | Deterministic | CFG 1 to 5 | `temperature`, `cfg_scale` | No | No | Stability, similarity, style |
| Pauses | Edit only (ellipsis gives a hesitation) | Edit | Edit | `<break time="400ms"/>` | `<break>` | Text / tags |
| Pronunciation | Respelling | Respelling | Respelling | `<phoneme>`, `<sub>`, lexicons | `<phoneme>`, lexicons | Pronunciation dictionaries |
| Multi-speaker | Voice blends, one per call | Reference clip per call | `[S1]` `[S2]` in one call | One voice per request | One voice per `<voice>` element | One voice per call |

ElevenLabs is listed for comparison only: its free plan has no commercial licence.

### Starting configurations (to test)

| Character type | Delivery | Kokoro speed | Zonos rate / pitch var / CFG | Pitch direction | Intensity | Pause style |
|---|---|---|---|---|---|---|
| Calm intellectual | Controlled, precise | 0.95 | 14 / 40 / 2.5 | Falling endings | 3/10 | 300 ms before the key word |
| Nervous | Uncertain, variable | 1.08 with 0.92 chunks | 17 / 120 / 1.8 | Rising endings | 6/10 | Short, irregular |
| Overconfident | Strong, deliberate | 1.0, 0.9 on the claim | 15 / 70 / 2.5 | Falls hard | 7/10 | Before the stupid word |
| Sarcastic | Dry, understated | 0.88 | 13 / 30 / 2.0 | Flat, one lift | 3/10 | Long before the line |
| Angry | Controlled frustration | 1.05, 0.9 on the hit word | 16 / 90 / 2.5 | Rises then clips | 7/10 | Almost none, then one hard stop |
| Confused | Hesitant, questioning | 0.9 | 13 / 80 / 1.8 | Rising | 4/10 | Before nouns |
| Energetic | Fast, expressive | 1.15 | 19 / 140 / 2.0 | Wide | 8/10 | Minimal |

**Adjusting:**
- **Too robotic:** shorter chunks, vary speed by chunk, rewrite as fragments.
- **Unstable or garbled** (Zonos or Dia): raise CFG by 0.5, lower temperature by 0.1, shorten the text.
- **Exaggerated:** lower emotion sliders by 0.2 or speed toward 1.0.
- **Inconsistent between episodes:** lock blend weights, model version and reference clip.

---

## 6. Writing for TTS

The bad version, *"I cannot believe that you actually decided to do that. This is an absolutely terrible idea."*, rewritten per character:

- **Deb:** "Okay so. No. (beat) NO. Who approved this. I'm posting it."
- **Marcus:** "Respectfully? Bold. (beat) Wrong, but bold. Can I invest?"
- **Priya:** "...why."
- **Gord:** "In nineteen eighty-seven, a man did exactly that. (600 ms) We don't talk about him."
- **Wendy:** "Pleased to announce I've formed a task force about that. Going forward."

**Rules**
- Split sentences at every change of thought, and keep lines under 12 words.
- Always use contractions unless the character is formal (Wendy) or making a point ("I do *not*").
- Cut adverbs, cut "actually", "really" and "absolutely" unless they're the joke.
- Full stops give a hard stop. Commas give a short breath. Ellipsis gives a hesitation. Question marks lift the ending.
- Avoid em dashes, brackets, slashes, emoji and ALL CAPS in TTS text. Put caps in captions only, and get the stress through the chunk split.
- Write interruptions as two separate lines and overlap them in the edit.
- Write unfinished thoughts as the full phrase, then trim the tail in the edit (`trim` in `build_audio.py`).
- Slang: spell it the way it's said, once per Short.
- Names and fictional words: one respelling, used every time ("Barry" is fine; "Pemberton" may need "PEM-ber-tun").

**Script format for TTS** (one row per chunk):

| Cue | Char | Text sent to TTS | Caption text | Speed | Gap after (ms) | Stress | Intent |
|---|---|---|---|---|---|---|---|
| L06a | GORD | In nineteen eighty-seven, they filled the quarry. | In 1987 they filled the quarry. | 0.92 | 620 | **quarry** | Stubborn, wistful |
| L06b | GORD | Never the same. | Never the same. | 0.86 | 420 | **same** | Final |
| L06c | GORD | Gord's not moving. | Gord's not moving. | 0.90 | 0 | **not** | Immovable |

---

## 7. Multi-character dialogue

**When to generate line by line** (the default): you need control of the timing, interruptions or emotion changes, or the characters have different voices on a single-voice tool (Kokoro, Zonos, Google, Azure).

**When to generate a whole exchange together:** use a dialogue model (Dia with `[S1]`/`[S2]`) for a fast two-person argument whose rhythm you can't build by hand. Generate 3 takes and pick the best rhythm, then replace any bad line with a line-by-line take.

**Consistency:** lock blends and settings in code. Match loudness per character with `gain_db`. Never regenerate one line of a scene with different settings from the rest.

### Example: three characters

| Cue | Char | Text | Speed | Starts | Direction |
|---|---|---|---|---|---|
| A | MARCUS | "Respectfully, Barry is a brand." | 1.06 | 0.00 s | Pitching, pause before "brand" |
| B | MARCUS | "We're doing hoodies, a candle line, a podcast," | 1.16 | +0.16 s after A | Accelerating; trim the last 220 ms |
| C | PRIYA | "It's a hole." | 0.90 | 300 ms **before** B ends | Flat; cuts him off |
| D | WENDY | "Pleased to announce," | 1.00 | +700 ms after C | Bright |
| E | WENDY | "Barry is now a protected heritage site." | 1.00 | +120 ms | Lands each word |

**Editing:**
1. Duck Marcus by 5 dB for the duration of Priya's line.
2. Fade Marcus out over 40 ms at the trim.
3. Keep room tone running under the gaps.
4. Put no music under any of these lines.
5. Bring in the organ sting 150 ms after "site."

---

## 8. Audio processing

The chain below is what `build_audio.py` runs on the master, in this order. Per-character processing is limited to pitch and gain.

| Step | Setting | Why | When not to use it |
|---|---|---|---|
| High-pass | 70 Hz | Removes rumble that eats headroom | Never skip on dialogue |
| Low-mid cut | −2 dB at 250 Hz, Q 1.2 | Less boxiness on phone speakers | If a voice already sounds thin |
| Presence | +1.5 dB at 3.2 kHz, Q 1.0 | Intelligibility | If sibilance is already harsh |
| De-esser | ffmpeg `deesser=i=0.3` | Tames S sounds | If voices sound lispy afterwards: lower it |
| Compressor | Threshold −20 dB, ratio 2.5:1, attack 8 ms, release 120 ms, +2 dB makeup | Evens levels without pumping | Never above 4:1 on dialogue |
| Loudness | `loudnorm I=-14 TP=-1.0 LRA=9` | Shorts playback level, no clipping | n/a. This render measured −15.2 LUFS integrated, −0.9 dBFS peak, because single-pass loudnorm undershoots; use two-pass for an exact −14 |

- **Don't:** denoise TTS (it has no noise), add reverb by default, widen voices in stereo, or stack compressors.
- **Stereo:** voices centred. SFX can sit up to 30% left or right to match on-screen position.
- **Music:** stings only, at −4 dB relative to dialogue peaks, never under a line.
- **Improving a recording vs. faking a human:** EQ, compression and loudness fix how the audio is reproduced. They can't add performance. If a line sounds artificial after this chain, the problem is the text or the generation. Rewrite or regenerate it; don't process it more.

---

## 9. Comedy sound design

| # | Moment | Sound choice | Why it helps |
|---|---|---|---|
| 1 | Deb lights the candle | Lighter fails once, then lights | A small failure = character before the first word |
| 2 | Wide reveal of the pothole | Rubber-stamp thump on the cut | The format sting is diegetic (a real stamp), not a whoosh |
| 3 | Duck bumps the edge | Tiny squeak, quiet | The background joke rewards rewatching |
| 4 | Deb dictating | Keyboard clicks slightly behind her words | She's typing what she says, so the lag is the gag |
| 5 | "Heritage site" | Two-chord municipal organ, slightly cheap | Fake seriousness |
| 6 | Applause | Three claps together, one late | The late clap is Gord: character through sound |
| 7 | Gord blocks the truck | Idle rumble, one impatient horn tap | Contrast with Gord's calm |
| 8 | Night fix | Music cuts; crickets and a low roller hum | Silence before the reversal |
| 9 | "BARRY!" | Scissors clang 150 ms after, then a lone squeak | Impact after the scream, then deflation |
| 10 | "drive on it now" | 1.9 s of room tone and one bird | Silence is the punchline |
| 11 | Lenny's tag | Jackhammer, then a match strike | The ending loops back to the opening sound |

Avoid meme sound effects (vine boom, air horn, "bruh"): they're borrowed jokes and they date the channel.

---

## 10. Tools compared (researched 23 November 2026)

Full licence table: section 7 of `LESSER-PEMBERTON-PLAN.md`. Added this session:

| Tool | Licence (verified) | Free | Formats | Naturalness | Emotion | Speed / pitch | Multi-character | Pronunciation | Weakness | Best use |
|---|---|---|---|---|---|---|---|---|---|---|
| Kokoro-82M (via kokoro-onnx, CPU) | Apache-2.0 weights (HF model card read this session); kokoro-onnx wrapper MIT | Yes, unlimited | WAV | Clean, natural on short lines | None | `speed` only; pitch in post | Yes: 28 English voices, blendable | Respelling | No emotion control | **Best completely free and best open-source** |
| Zonos v0.1 | Apache-2.0 (repo); weights card unverified | Yes; needs GPU | WAV | Strong with a good reference | 8 sliders | Rate and pitch variation | Via reference clips | Respelling | 6 GB+ VRAM | **Best expressive (free)** |
| Dia | Apache-2.0 (repo); weights card unverified | Yes; GPU | WAV | Natural two-person rhythm | Non-verbal tags | Speed in demo | 2 speakers per call | Respelling | Only 2 speakers, GPU | Fast arguments |
| Google Cloud TTS | Pricing page read; output rights in the Cloud terms (not read) | Monthly free characters; card required | MP3, WAV, OGG | Good (Neural2, WaveNet) | Limited | Full SSML | One voice per request | SSML phonemes, lexicons | Needs billing account | **Best low-cost long-term with SSML / backup** |

**Rankings:**
- Best free: Kokoro.
- Best expressive: Zonos.
- Best for several characters: Kokoro blends (free) or Zonos reference clips.
- Best low-cost long-term: Google Cloud TTS.
- Backup: Google Cloud TTS, or Kokoro if you lose GPU access.

---

## 11. Production workflow

| # | Stage | Do | Look for | Redo when |
|---|---|---|---|---|
| 1 | Finalise dialogue | Read it aloud with a stopwatch | Lines over 12 words | It's over 95 words per 30 s |
| 2 | Assign lines | One row per chunk | Two characters in one row | Always split |
| 3 | Intention | Fill the intent fields | A blank "wants" field | The field is empty |
| 4 | Direction | Speed, gap, stress per chunk | Equal gaps everywhere | Three equal gaps in a row |
| 5 | Pronunciation | Respell names and numbers | Digits in TTS text | Any digit remains |
| 6 | Generate | Run `build_audio.py` | Errors, clipped lines | Any chunk fails |
| 7 | Listen | Line by line, eyes closed | Robotic rhythm, wrong stress | Score below 3/5 on a line |
| 8 | Regenerate | Change text first, settings second | The same problem again | Two failed takes means rewrite the line |
| 9 | Edit pauses | Trim or extend gaps by 40 ms steps | Rushed punchlines | The punchline arrives early |
| 10 | Align to picture | Shot starts from the timeline | Mouths flapping in silence | Off by more than 2 frames |
| 11 | SFX | Place on actions, never on words | SFX masking a word | Overlap with a stressed word |
| 12 | Mix | Master chain | Music over dialogue | Any music under a line |
| 13 | Listen on two systems | Headphones, then phone speaker | Lost words on the phone | Any word unclear |
| 14 | Final QC | Section 12 scoring | Score below 85 | Pronunciation, intelligibility or consistency fails |

**Folders and file names:**

```
shorts-channel/
  voices/cast.json                      # blend weights, pitch, gain, model version (lock it)
  episodes/S01-barry/
    script.md                           # cue table
    audio/L06b_GORD_v2.wav              # cue_char_take
    audio/sfx/                          # one file per effect, with licence notes
    mix/S01_mix_v3_-14LUFS.wav
    render/S01_barry_v3_1080x1920.mp4
```

---

## 12. Voice quality scoring sheet

| Category | Points | Full marks when | Zero when |
|---|---:|---|---|
| Natural rhythm | 15 | Pauses vary, speed changes with meaning | Metronomic |
| Emotional expression | 15 | Each line has a clear intention that changes when the scene changes | Same emotion throughout |
| Character identity | 15 | Eyes closed, you can name every speaker | Two characters confusable |
| Pronunciation | 10 | Every name and number right | Any wrong name |
| Conversational realism | 15 | Interruptions, reactions, silences | Perfect turn-taking |
| Comedy timing | 15 | Every punchline lands on its own beat | Punchlines rushed |
| Audio quality | 10 | Clear on a phone, no clipping, no harshness | Distortion or masking |
| Consistency | 5 | Voices match across scenes and episodes | A voice changes |
| **Total** | **100** | Approve at **85+** | |

Fix any pronunciation, intelligibility or consistency problem whatever the total.

**Blind comparison between tools:**
1. Generate the same 5 lines in each tool.
2. Loudness-match them to −16 LUFS.
3. Have someone else rename the files randomly.
4. Score them on the sheet above without knowing which tool made which.
5. Unblind only after all scores are in.

Don't use AI-detection scores: they measure statistical artefacts, not whether a performance works.

---

## 13. Troubleshooting

| Symptom | Likely cause | Immediate fix | Long-term solution |
|---|---|---|---|
| Robotic | Long chunks, written prose | Split into phrases, vary speed | Write for speech from the start |
| Emotionless | No intention, neutral text | Rewrite the line so the emotion is in the words | Intent field per line; an expressive model (Zonos) |
| Too fast | Speed above 1.15, gaps too short | Lower speed by 0.05, add 150 ms gaps | Per-character speed range |
| Too slow | Speed under 0.85, long gaps | Raise speed, trim gaps by 40 ms steps | Same |
| Characters sound identical | Similar presets | New blend; change rhythm and word choice | Section 4 profiles |
| Wrong pronunciation | Unknown word | Respell | Pronunciation table |
| Too clean | Dry studio-style output with no room | Room tone under it | Location-matched room-tone beds |
| Metallic | Over-shifted pitch, processing | Reduce the shift, remove denoise | Blend instead of shifting |
| Nasal | Preset resonance | −2 to −3 dB at about 1 kHz | Different base voice |
| Unnatural dialogue | Written turn-taking | Add an interruption and a silence | Script conversational behaviour |
| Punchline doesn't land | Same energy as the setup | Own chunk, pause before it, slower | Mark punchlines in the script |
| Awkward pauses | Pause after the wrong word | Move the pause before the stressed word | Stress column |
| Exaggerated emotion | Sliders or speed too high | Pull toward neutral by 30% | Intensity scale per line |
| Voices change between scenes | Settings changed | Regenerate with locked settings | `cast.json` |
| Clash with music | Music under lines | Remove music under dialogue | Stings only |
| Sounds like a narrator | Full sentences, neutral voice, no addressee | Rewrite as talking *to* someone | Every line has a listener |
| Strange artefacts | Model glitch on rare words or very short text | Regenerate; pad very short text ("Caps." alone can glitch) | Avoid single-syllable chunks on unstable models |

---

## 14. Three example scenes

### Scene 1: Short 01 (rendered)

The Short 01 cues and settings are in `workshop/video/build_audio.py` (`CUES`) and its sound design is in section 9. Resulting cue timing in the render:
- Deb: 0.3 to 2.8 s.
- Deb's post: 4.6 to 9.95 s.
- Marcus: 10.5 to 14.6 s.
- Priya interrupts: 14.33 s.
- Wendy: 16.05 to 19.37 s.
- Gord: 20.37 to 27.86 s.
- Night: 30.2 to 32.5 s.
- "BARRY!": 33.26 s.
- Priya: 34.76 to 37.7 s.
- Silence: 1.9 s.
- Lenny tag: to 42.9 s.

### Scene 2: "The Self-Checkout Asked Me to Tip Myself"

| Cue | Char | TTS text | Speed | Gap | Stress | Intent / SFX |
|---|---|---|---|---|---|---|
| 1 | GORD | Who served me? | 0.86 | 600 | **who** | Genuinely puzzled. SFX: polite chime before |
| 2 | MACHINE (Piper `en_US-joe-medium`) | Please rate your cashier. | 1.0 | 300 | none | Flat on purpose |
| 3 | GORD | That's Gord. | 0.88 | 900 | **Gord** | Recognition, then a long beat |
| 4 | GORD | He was a bit slow, to be fair. | 0.9 | 200 | **slow** | Honest self-review |
| 5 | MARCUS | The customer is the staff. | 1.1 | 0 | **is** | Overconfident pitch |
| 6 | PRIYA | So who gets the tip? | 0.9 | 400 | **who** | Starts 200 ms before Marcus ends |
| 7 | MARCUS | ...The brand. | 1.0 | 500 | **brand** | Caught out, recovers |
| 8 | GORD | (after 1.2 s of room tone) Worth it. | 0.84 | 0 | **worth** | Resigned. SFX: no music; lock click before |

### Scene 3: "His Fridge Updated Its Terms. He Said No."

| Cue | Char | TTS text | Speed | Gap | Stress | Intent / SFX |
|---|---|---|---|---|---|---|
| 1 | GORD | Continue what? It's milk. | 0.9 | 300 | **milk** | Offended by the premise. SFX: rubber seal straining under the line |
| 2 | PRIYA | Just press accept. Everyone presses accept. | 0.92 | 200 | **everyone** | Bored, cereal in mouth |
| 3 | GORD | Gord doesn't sign things he hasn't read. | 0.88 | 500 | **read** | Principle |
| 4 | GORD | That's how I got the timeshare. | 0.86 | 0 | **timeshare** | Quiet, rueful. The quiet makes it funnier |
| 5 | GORD | Section sixty. Fridge may adjust temperature for your wellbeing. | 0.9 | 400 | **wellbeing** | Reading aloud, suspicious |
| 6 | GORD | Is that why the butter's warm? | 0.86 | 700 | **butter's** | Dawning realisation |
| 7 | MARCUS | You can't negotiate with a fridge, that's not how | 1.15 | 0 | **fridge** | Trim the tail; cut off by the fridge chime |
| 8 | MARCUS | ...no. | 0.85 | 0 | none | Whispered after the toaster pops (SFX) |

---

## 15. Workflows

**Free (what this render used):**
1. Kokoro via kokoro-onnx on CPU (Apache-2.0 weights).
2. Line-by-line generation with blends, speed and gaps, controlled by `build_audio.py`.
3. Rubberband pitch within ±1.5 semitones.
4. Procedural or self-recorded SFX.
5. ffmpeg master chain.
6. Animation rendered in a browser and encoded with ffmpeg.

Cost: nothing. Weakness: no emotion control, so the text and the edit carry all the acting.

**Quality-focused:**
1. Record a 20 to 30 s reference performance per character yourself (or with friends who give consent).
2. Run Zonos on a GPU (free Colab or a 6 GB+ card) with the emotion sliders, generating 3 takes per line.
3. Use Dia for fast two-person arguments.
4. Use Google Cloud TTS for machine characters and anything that needs SSML.
5. Apply the same master chain.
6. Run a blind A/B against Kokoro every month to check the extra effort is audible.
