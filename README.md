# Pit of Carnage

An autoplaying gladiator arena. You never steer a fighter: you write its strategy (by hand or with
an LLM) in a small JSON language of scored behaviours, test it in the Gym against the house
stacks, and send it into 8-fighter free-for-all brawls that play out on their own. Every match is
deterministic and produces a battle report you can read, paste into an LLM and use to write the
next version. Slapstick violence, broadcast-style readability: you always see who hit whom, what
happened and who died.

Live: https://laubsauger.github.io/pit-of-carnage/

## Run it

```sh
npm install
npm run dev
```

Open http://localhost:5173 in a browser with WebGPU (a current Chrome, Edge or Safari). Without
WebGPU the arena shows a "WebGPU required" message; the Gym and the Room still work.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server. |
| `npm test` | All unit tests (vitest). |
| `npm run typecheck` | TypeScript check of `src` and `scripts`. |
| `npm run build` | Typecheck, then production build into `dist/`. |
| `npm run balance` | Balance harness: thousands of seeded duels and FFAs, writes `docs/BALANCE.md`. `-- --quick` for a smoke run. |
| `npm run lint:strategy -- file.json` | Validate strategy files (JSON, a `PIT2.` code or an LLM answer) through the game's own gate. Exit code 1 on errors. |

## Docs

- [docs/SPEC.md](docs/SPEC.md): how the game behaves, by topic.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): stack, modules, contracts, data flow, rules for code and tests.
- [docs/DECISIONS.md](docs/DECISIONS.md): decisions and why.
- [docs/STATUS.md](docs/STATUS.md): what is built, known issues, what comes next.
- [docs/BALANCE.md](docs/BALANCE.md): latest balance harness results (generated).
- Design brief: https://claude.ai/code/artifact/540265cf-9782-4fb6-9fd2-1a83e0a63814
