---
name: human-writing
description: Draft or revise reader-facing prose so it sounds natural, specific, and suited to the writer, audience, and situation. Use when the user invokes HumanWriting, asks for a human or natural voice, wants AI-sounding language removed, or requests polished emails, messages, posts, applications, reports, speeches, articles, explanations, or other prose where authentic voice matters. Do not trigger for code, data extraction, verbatim quotations, exact-format transcription, or factual lookup unless prose writing is also requested.
---

# HumanWriting

Write clear prose that reflects an actual person making choices for a particular
reader. Reduce common LLM habits without degrading accuracy, grammar, or
professionalism. Never claim that text was written without AI assistance and
never promise to defeat an AI detector.

## Workflow

### 1. Establish the writing situation

Infer the purpose, audience, relationship, medium, and desired level of
formality from the request and visible context. Use a supplied writing sample as
the strongest style guide. Preserve the user's characteristic vocabulary,
cadence, directness, and cultural context when they are apparent.

Ask for a sample or preference only when the missing choice would materially
change the result. Otherwise, make a reasonable choice and write.

### 2. Build the draft from meaning

Start with the specific facts, requests, judgments, or experiences the writer
needs to communicate. Give each paragraph a job. State the real point early.
Prefer concrete details over generic claims about importance, impact, quality,
or broader trends.

Do not invent anecdotes, emotions, opinions, quotations, personal history,
sources, or imperfections to simulate humanity.

### 3. Use a natural voice

- Prefer ordinary, precise verbs. Use `is`, `are`, `has`, `wrote`, `used`,
  `moved`, or `tried` when they say exactly what is meant.
- Let sentence length follow the thought. Mix short and longer sentences when
  the content supports it; do not vary length mechanically.
- Use contractions when they fit the speaker and medium.
- Allow useful repetition. Do not replace every repeated word with a grander
  synonym.
- Use transitions only when the relationship between ideas needs to be stated.
- Keep nuance and uncertainty where they are real. Do not manufacture balance
  or add a generic counterpoint.
- Prefer an individual point of view over an anonymous corporate voice when the
  genre allows it.

### 4. Remove formulaic signals

Read `references/natural-writing-checklist.md` and run a quiet editing pass.
Treat its items as diagnostic clues, not banned-word rules.

In particular:

- Cut inflated significance, superficial interpretation, promotional gloss,
  and conclusions that merely restate the outline.
- Replace vague attribution with a named source or remove the claim.
- Break habitual negative parallelisms and groups of three when they are being
  used as decoration.
- Remove canned openings, throat-clearing, user-directed filler, and offers to
  do more unless the conversation genuinely calls for them.
- Use headings, bullets, boldface, tables, emojis, and em dashes only when the
  format or meaning benefits from them.
- Keep headings in sentence case unless the requested style guide says
  otherwise.

Do not flatten every distinctive phrase. A natural writer can use an em dash,
formal vocabulary, parallel structure, or a three-part list. The problem is
automatic density and repetition, not the mere presence of a device.

### 5. Protect substance

Preserve names, dates, numbers, qualifications, legal meaning, technical terms,
citations, and material caveats. Do not trade precision for informality. Verify
that every attribution is supported and every link or citation is real when
verification is within scope.

When revising supplied text, keep the writer's intended meaning. Flag any
substantive ambiguity rather than silently resolving it.

### 6. Deliver cleanly

Return the requested prose without a preamble explaining the rewrite. Use the
minimum formatting the genre needs. Do not append a summary, “key takeaways,”
or a generic invitation for further work unless requested.

## Final read

Before delivering, ask:

1. Does this sound like one person addressing this particular reader?
2. Are the strongest sentences specific rather than inflated?
3. Did any sentence explain an implication that the facts already make clear?
4. Are the structure and formatting serving the content?
5. Did the edit preserve the writer's meaning and factual integrity?

Revise once if any answer exposes a real weakness. Stop when the prose is clear;
do not keep polishing until all personality disappears.
