# How I work

The train is the last step. This is everything before it, with real examples from building [Hakutaku](https://hakutaku.ai). Short version: I let agents write almost all the code, and I spend my time making sure they're building the right thing and proving it works.

## 1. Plans get grilled, then mapped

Before any code, the plan gets interrogated with [/grill-me](skills/grill-me) (copied here with [/grilling](skills/grilling), which does the actual work), Matt Pocock's skill that asks you one hard question after another until the plan stops having holes. It's uncomfortable. That's how you know it works.

Then [/wayfinder](skills/wayfinder) (also Matt's, also copied here) turns it into a map: a coverage ledger of everything the change touches, and small tickets, each with an acceptance check you can actually test.

Example: moving the whole UI to a WhatsApp-style app. The ledger listed 284 surfaces. That became 87 tickets in 6 phases, each phase behind its own switch, with one rule on top: nothing gets removed without my sign-off. Agents love deleting things. I love having things.

## 2. Research has two arms

Every research question goes to two researchers at once: my own Hakutaku agent (the "Professor") and Claude. Then one report merges them and says out loud where they disagree. The disagreements are the useful part.

Example: auditing a competitor's app live, with a reverse-engineering MCP driving it. 40 modals mapped. Way better than me clicking around and forgetting half of it.

## 3. Prototypes before code

Nothing UI ships from a description. First a clickable HTML prototype, in 3 variants. Then contact sheets with the reference designs right next to them, in light and dark, at 1280 and 375 wide.

Then the robots check it. An automated layout audit went from 499 findings to 0 on one of these. And an interaction test clicks every single button, because "it looks right" and "it works" turned out to be different things.

## 4. A/B everything

The rule: research, then A/B against the current flow, ship only the winners, then validate live.

Example: a "warm-up" feature for the chat, judged blind. With k=1 it looked like a win. Then it lost on tone. Then a tie. Then k=3 on 3 themes: 108 to 119. Only then did it ship. If I'd stopped at the first run I'd have shipped a coin flip and called it a feature.

The same goes for speed: [/optimize](skills/optimize/SKILL.md) measures the built app, fixes the biggest cost and proves it with interleaved A/B runs and statistics.

## 5. Debug from evidence

No "I think the model got confused". Every turn leaves a trace, and every decision in it can be read back. Example: a classifier scored "Confirmo, pode mandar" (Portuguese for "confirmed, go ahead") at 0.12 as a confirmation. That's a very confident no to a very clear yes. Found it in the trace, not by guessing.

Then the fix gets proven on real conversations: replay before, replay after, cost and time per turn, and a chart of how it improved. If the chart doesn't move, the fix didn't happen.

## 6. /simplify after every feature

Right after a feature works, [/simplify](skills/simplify) runs (it's built into Claude Code, so jstack only points at it: parallel review agents look for reuse, simplification, efficiency and the right level of abstraction, then apply the fixes). Agents write code that works. They don't always write code you'd want to read. This is the cleanup crew.

## 7. Then the train

Many branches done, one build, one PR. See the [README](README.md) and [`skills/train`](skills/train/SKILL.md). My laptop thanks you.
