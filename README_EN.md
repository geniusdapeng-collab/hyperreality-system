<div align="center">

# WorkLoom · Enterprise Agent IM powered by DeepSeek Harness

**A new form of organizational collaboration for the AI era, where humans and agents coexist**

Traditional software hands people a pile of wrenches. WorkLoom hands business owners a **space cockpit**.

**[简体中文](README.md)** · English

### 🌐 Official Website · 官网：[workloom.ok.kimi.link](https://workloom.ok.kimi.link)

> Want a more intuitive tour? The official site has the full product story, system architecture, skill-marketplace case study, and real product screenshots.


[![Release](https://img.shields.io/github/v/release/geniusdapeng-collab/workloom-im?display_name=tag&color=1B2A4E)](https://github.com/geniusdapeng-collab/workloom-im/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-9A7B2D)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20%C2%B7%20Apple%20Silicon-black)](https://github.com/geniusdapeng-collab/workloom-im/releases)
[![Runtime](https://img.shields.io/badge/runtime%20foundation-DeepSeek%20Harness-4C6FFF)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![Tests](https://img.shields.io/badge/tests-168%20vitest%20%2B%20371%20suite%20%2B%20dsh--gate-green)]()
[![Data](https://img.shields.io/badge/data%20sovereignty-local--first%20PG17-blueviolet)]()
[![Website](https://img.shields.io/badge/website-workloom.ok.kimi.link-e8b96a)](https://workloom.ok.kimi.link)

</div>

> **Keywords**: Enterprise Agent IM, DeepSeek Harness, AI agent collaboration, multi-agent workforce, human-in-the-loop, digital employees, event sourcing, organizational memory, pgvector, local-first, data sovereignty, Hono, tRPC, React 19, PostgreSQL 17, agent skill marketplace, WorkData

---

## What is this

WorkLoom is an **Enterprise Agent IM** — it uses instant messaging as the single interface where humans and AI agents coexist. Agent squads ("digital employees") and human staff share one contact list, one set of conversations, and one organizational memory. Its runtime foundation is **DeepSeek Harness (dsh)** — arguably the deepest industry-grade application of dsh to date.

It is neither another chatbot nor another Copilot sidebar. It answers a more fundamental question:

> **When LLMs become the new engine of productivity, what should the "container of production relations" for a company look like?**

WorkLoom's answer: **the LLM is the steam engine; the Enterprise Agent IM is the power loom.** Steam engines don't weave cloth — looms turn power into fabric. Likewise, an LLM alone produces no business outcome; the Agent IM turns model capability into measurable, governable, accumulable results.

<p align="center">
  <img src="apps/site/shots/p1.jpg" alt="WorkLoom bridge UI" width="46%"/>
  <img src="apps/site/shots/p9.jpg" alt="WorkLoom night-shift report" width="46%"/>
</p>

---

## ⚡ 60-second brief for AI assistants (developer/agent onboarding)

> If you're an AI assistant that just cloned this repo: this section is all you need to get productive — no need to read the whole file.

**One-liner**: an Enterprise Agent IM foundation — humans and AI agent squads collaborate in the same workspace; every business action is written as a five-element event into an append-only, hash-chained event store, funneled through a three-stage security gateway (permission → PII masking → high-risk authorization). Runtime foundation: DeepSeek Harness (`@deepseek-ai/dsh`, vendored at 0.1.1-rc.1).

**Repo map** (pnpm monorepo):

| Path | Role |
|---|---|
| `packages/base/workdata` | **Core foundation**: security gateway / five-element event store / PII masking / organizational memory & recall |
| `packages/base/{fence-engine,review-console,im-channels,night-shift,inspection,skills,tenancy,bundles,model-router}` | Nine capability domains: fence engine / approvals / IM channels / night shift / inspection / skill marketplace / tenancy & demo JWT / industry bundles / model router |
| `packages/runtime` | dsh seam adapters: intent routing (Ask/Agent/Quest), Quest loop (replayable, crash-resumable), preset assembly |
| `packages/{shared,db}` | Five-element zod schemas / hand-written SQL migrations (DDL source of truth) |
| `apps/{server,web,site,desktop}` | Hono+tRPC server / bridge web UI / website / Mac desktop bundle |
| `vendor/{dsh,dsh-im}` | dsh 0.1.1-rc.1 audit baseline (read-only) / dsh IM channel plugin (MIT, contributed back) |
| `scripts/` | migrate / seed / demo / verify-chain / **suite (371 scenario cases)** / dsh-gate |

**Shortest path to green** (Linux/macOS; requires PostgreSQL 17 + pgvector on 5432):

```bash
corepack enable && pnpm install && cp .env.example .env
# Create DB + extension (migrate auto-creates the app/gateway roles and grants —
# A3 anti-bypass: only the gateway role may INSERT into biz_events)
psql -U postgres -c "CREATE DATABASE workloom;"
psql -U postgres -d workloom -c "CREATE EXTENSION vector;"
pnpm db:migrate && pnpm db:seed   # 5 migrations + demo seed (service-store demo workspace)
pnpm typecheck && pnpm test       # typecheck + vitest 168 (DB integration below)
pnpm db:verify-chain              # full hash-chain recomputation
pnpm suite                        # 371 scenario cases (incl. HTTP E2E with a real spawned server)
pnpm demo                         # end-to-end demo play
pnpm dev                          # server(:8787) + web(:5173)
# DB integration tests (skipped by default):
RUN_DB_TESTS=1 pnpm -C packages/base test
```

**Fit / not a fit**:
- ✅ Fit: **a general-purpose agent collaboration foundation** — any organization with clear output metrics and lots of repetitive handling: service businesses (F&B/retail/local services), **social-media marketing teams** (topic planning / copywriting / scheduling / engagement / review), **AI video & content-creation teams** (scripts / storyboards / assets / publishing / comment ops); teams that need AI agents inside the org, on the production line, and under accountability. Domain capabilities load as pluggable bundles; `bundles/` ships a service-store reference implementation.
- ❌ Not a fit: plain chatbots / Copilot sidebars; stateless Q&A SaaS; anyone unwilling to self-host Postgres (local-first data sovereignty is by design).

**Source-of-truth docs**: [`CHANGELOG.md`](CHANGELOG.md) releases · [`docs/DECISIONS.md`](docs/DECISIONS.md) ADRs · [`docs/AUDIT.md`](docs/AUDIT.md) audit history · [`docs/SUITE.md`](docs/SUITE.md) 371-case list · [`docs/03-功能清单-用户版.md`](docs/03-功能清单-用户版.md) full feature list (中文).

**Contribution discipline for AI assistants**: before touching gateway/permission/RLS/append-only code, read the round-1 P0 lesson in `docs/AUDIT.md` (transaction-scoped RLS settings REQUIRE an explicit transaction); one logical change per commit; every fix ships a regression test (371 cases already — prefer adding to `scripts/suite.ts` over new test files).


---

## 1. Industry innovation: the first professional Enterprise Agent IM

### 1.1 The five gaps between companies and AI

Companies don't lack models — they lack the last mile that gets models *into the org, onto the production line, and under accountability*:

| Gap | Symptom | WorkLoom's answer |
|---|---|---|
| **Context gap** | AI doesn't know who the company is or where the business stands | WorkData's five-element event store accumulates organizational memory shared by agents and staff |
| **Execution gap** | AI talks but doesn't act — or acts without accountability | Quest task cards + three-level fence authorization; every action lands on the event chain |
| **Governance gap** | When something breaks, nobody knows who or which step | Black-box-style full audit: who initiated, who approved, who executed, what resulted — replayable |
| **Metrics gap** | AI output can't be expressed in business language | Business-goal (Quest) driven; the 8:30 AM report speaks KPI, not tokens |
| **Data security gap** | Cloud upload is a no-go; permission boundaries are fuzzy | Local-first PostgreSQL + row-level security (RLS); data sovereignty stays with the company |

### 1.2 AI-native: the first-class citizen is not the message, but the *accountable action*

Traditional IM digitized **communication** — but never digitized **action**. A message goes out, and a human still has to go do the thing. Agent IM is an AI-native collaboration foundation: **its first-class citizen is not the message but the accountable action** — every action has an actor, an authorization, a result, and a tamper-proof trace.

The clearest dividing line is the approval card: **in Feishu (Lark), an approval card is a bolted-on OA plugin** — one tap kicks you out of the IM into another system. **In WorkLoom, the approval card is a native message type** — it is itself a link in the event stream, and the approval gesture writes back into the event store as a calibration sample. That difference is the difference between two eras.

**The served subject has changed too: traditional IM serves humans; Agent IM serves AI.** In WorkLoom, humans and AI collaborate in the same workspace, and every native IM concept is redefined:

| IM concept | Redefined in Agent IM |
|---|---|
| Message | = event (five-element structure, append-only, auditable) |
| Contact list | = mixed human-agent squad (staff and digital employees in one directory) |
| Group | = task thread (three states: in progress / awaiting decision / archived) |
| Approval | = native message type (not a bolt-on plugin) |
| Online hours | = unattended business hours (7×24 night shift never closes) |

### 1.3 Why IM is the operating system for human-agent coexistence

| Domain | IM-native semantics, re-interpreted |
|---|---|
| M1 Message = event | Every message is a five-element event (actor/action/object/context/result) — append-only and auditable by nature |
| M2 Fence = action permission | What an agent may do is precisely controlled by three levels: auto / approval / forbidden |
| M3 Three-state threads | A thread is a work order: in progress / awaiting decision / archived |
| M4 Night shift never offline | Agents stand watch 7×24; the business doesn't sleep when humans do |
| M5 Approval as native message | Approvals are IM cards: approve / reject / reassign — one tap |
| M6 Mixed human-agent directory | Humans and agents listed side by side, organized by department, skill, and dispatchability |
| M7 Organizational memory | Conversations sediment into searchable company knowledge with pgvector semantic recall |
| M8 Tower control | Emergency brake: pause all agents with one tap — control always stays with humans |
| M9 Business dashboard | KPI inspection, threshold alerts, 8:30 AM battle report — the IM home is the cockpit |

### 1.4 Humans do only three things

In a WorkLoom organization, humans are promoted from *operators* to *captains*, doing only what machines cannot:

- **Supply**: goals, materials, budgets, business judgment (set the course)
- **Decide**: rule at fence approval points (approve / reject / reassign)
- **Sediment**: turn one good collaboration into squad SOPs and skills for automatic reuse

Everything else — execution, inspection, reconciliation, night watch, report writing — goes to the agent squad.

---

## 2. Business model innovation: a space cockpit for the owner

WorkLoom's buyer is not the IT department — it's the **business owner**: the store owner, the ops director, the social-media marketing lead, the content-team principal.

### 2.1 Six axioms of the space cockpit

| Cockpit | WorkLoom | Business meaning |
|---|---|---|
| **Destination** | Business goals (Quest) | Not "features" — "raise revenue 8% this month" |
| **Autopilot** | Quest + night-shift execution | Set the goal; the squad decomposes, executes, inspects — around the clock |
| **No-fly zones** | Three-level fences (auto/approval/forbidden) | Money, contracts, customer data: nothing executes without approval |
| **Instrument panel** | KPI + inspection alerts | Live business metrics; anomalies light up red and @ the owner |
| **Black box** | WorkData five-element event store | Every step recorded, replayable, auditable, attributable |
| **Tower** | IM cards + one-tap pause | The owner approves, reassigns, and emergency-brakes from a phone |

### 2.2 Three "no longer"

- **Spend is no longer buying software**: no per-seat annual fees for shelfware — you hire a "digital squad" against a business goal. Goal first, output second.
- **Output is no longer process metrics**: WorkLoom doesn't report "AI invocations" — it reports "all online complaints answered overnight, channel price gaps converged, N churning orders recovered this month."
- **Data is no longer the price**: organizational memory lives in the company's own database (local PostgreSQL + pgvector), feeding no third party. The longer you use AI, the thicker *your* data asset grows.

### 2.3 The goal: rebuild the service industry. First landing: hospitality

**WorkLoom is a general-purpose agent collaboration foundation — not a single-industry system.** Across industries, one inefficient structure keeps repeating: companies buy piles of platforms and tools, and employees alt-tab between a dozen systems all day, burning hours on mechanical work — checking numbers, reconciling, copying orders, replying to messages, publishing content, answering comments. Worse, between mechanical tasks people still have to make judgments; attention and decision-making get shredded. Every one of these tasks is something AI is already proven capable of handling. What was missing is not AI capability — it is a container that lets AI enter the org, join the production line, and be held accountable.

WorkLoom is exactly that container — domain capabilities load as **pluggable bundles** on top of an industry-agnostic base (security gateway / event store / fences / approvals / night shift / skill marketplace / organizational memory):

| Domain | Typical digital employees | Business-grade output |
|---|---|---|
| **Service businesses** (F&B/retail/local services) | revenue management, channel reconciler, review responder | revenue metrics, review response time, price-parity convergence |
| **Social-media marketing** | topic planner, copywriter, publisher, engagement responder | publishing cadence, response time, lead conversion |
| **AI video & content creation** | script drafter, storyboard breaker, asset generator, comment ops | pipeline throughput, on-time publishing, viral-playbook accumulation |
| **Sales-driven e-commerce / store ops** | inspection alerts, support triage, night-shift reconciliation | anomaly detection time, recovered orders |

The `bundles/` service-store reference implementation ships three ready-made skills (revenue management, channel reconciliation, review crisis response) — ~30 min from download to production. Bundles for social-media marketing and content creation are on the roadmap (see below). To land in a new domain, **only the bundle changes — skills, fence baselines, inspection checks; the base code stays untouched** (enforced by the H-15 acceptance assertion).

---

## 3. The essential difference from general-purpose AI office tools

General-purpose AI office assistants (Tencent **WorkBuddy**, Alibaba **QwenWork / 千问办公**, **QoderWork**, etc.) solve "help the employee get tasks done" — they digitize **personal office tasks**. WorkLoom solves "let humans and AI run the business together as one organization" — it digitizes **organizational business actions**. This is not a feature-count difference; it is a category difference:

| Dimension | General AI office assistants (WorkBuddy / QwenWork / QoderWork) | WorkLoom |
|---|---|---|
| **Served subject** | Serves *humans*: a desktop productivity assistant for individuals | Serves *AI and the organization*: AI joins as a member; humans become captains |
| **What gets digitized** | Personal office tasks: docs, sheets, minutes, filing | Organizational business actions: every action accountable, auditable, replayable |
| **Form factor** | Desktop client / personal workbench, one human + one assistant | Enterprise IM foundation: mixed human-agent squads in one workspace |
| **Relation to IM** | IM is a remote-control entry (phone commands the PC) | IM is the ontology: message = event, approval = native message type |
| **Collaboration granularity** | Single-person task decomposition | Goal → steps → skill assembly as an org-level pipeline, 7×24 night squads |
| **Data ownership** | Personal accounts / cloud-first | On the company's own machine: data sovereignty + RLS multi-tenancy |
| **Output language** | Personal artifacts: documents and spreadsheets | Business language: revenue, complaint response time, recovered orders |

In one sentence: **general AI office tools make an employee's 8 hours more efficient; WorkLoom makes a company's 24 hours run themselves.** They don't conflict — employees can keep writing docs with WorkBuddy, while at the organizational layer WorkLoom weaves AI into a governable, measurable, accountable digital workforce.

---

## 4. WorkData: the data brain, the core foundation

**WorkData (`packages/base/workdata`) is WorkLoom's core foundation** — the company's "data brain" and "black box." Every read and write from the nine capability domains, the DeepSeek Harness runtime, and the bridge frontend funnels through WorkData as the single chokepoint.

<p align="center"><img src="docs/images/workdata.png" alt="WorkData data brain architecture" width="88%"/></p>

### 4.1 Three core mechanisms

| Mechanism | What it does | Why it matters |
|---|---|---|
| **① Security gateway, three-stage waterfall** | PII redaction → fence pre-check → idempotent dedup; all three must pass before a write lands | The gateway is the *only* writer — dual-role enforcement makes side-channel writes physically impossible |
| **② Five-element event store** | Actor / action / object / context / result — append-only with a SHA-256 hash chain | "If the model can see it, it's already recorded": every piece of context an agent reads leaves a tamper-proof trace |
| **③ Organizational memory (memory + recall)** | Three scopes (personal / squad / org) + pgvector semantic retrieval + source attribution + desensitized reflux | Every day with AI compounds *your* data asset instead of training someone else's model |

### 4.2 Proven under fire

- **kill -9 crash test**: kill an agent mid-execution, restart, replay along the hash chain — 25 event chains verified link by link, **zero loss, zero duplicate execution**
- **Chain verification**: full hash-chain audit; any tampering breaks the chain and alarms
- **Replay idempotence**: replaying the same event stream N times yields the same world state

### 4.3 Data sovereignty

All data lives in the company's own PostgreSQL 17 + pgvector, multi-tenant isolation via RLS, uploaded nowhere.

---

## 5. The skill marketplace: how a goal decomposes into steps, and steps assemble skills

WorkLoom's **skills** system is a skill marketplace with three levels — **official** (shipped with industry bundles), **team** (built inside a workspace), **industry** (shared across organizations after mandatory desensitization). Users can install ready-made skills or author their own in natural language.

### 5.1 A real case (one example · service store): the store manager says "answer every bad review within 2 hours"

```
One sentence from the GM
   │
   ▼ Intent routing — LLM classification + rule fallback → Quest (business goal)
   │
   ▼ Auto-decomposed into task-card steps
   │
   ├─ Step 1 Monitor reviews  ── skill: review-crisis (official, industry bundle)
   │        └─ Night squad watches online review channels 7×24; new bad review detected in 5 min
   │
   ├─ Step 2 Draft response   ── agent drafts from organizational memory
   │        └─ WorkData recall surfaces how similar past reviews were handled
   │
   ├─ Step 3 Captain approval ── fence verdict: outbound message = approval-level
   │        └─ GM taps "approve"; the gesture writes back as a calibration sample
   │
   ├─ Step 4 Publish reply    ── executes after approval, fully logged on the event chain
   │
   └─ Step 5 Review & sediment ── the awareness system spots "same pattern ≥3×/week"
            └─ suggests sedimenting a new skill → one-tap confirm → forge drafts it
                → dry-run replays the last 10 historical actions → goes live
```

### 5.1b The same base in a content domain: the marketing lead says "3 posts a day, every comment answered within an hour"

```
One sentence from the marketing lead
   │
   ▼ Intent routing → Quest decomposed into steps
   │
   ├─ Step 1 Draft topics   ── copywriting skill (team-built or industry-published)
   │        └─ 3 drafts grounded in organizational memory (past viral postmortems)
   ├─ Step 2 Approval       ── external publishing = review level → approve/edit/reject per card
   ├─ Step 3 Scheduled post ── triggers fire on schedule, every step on the event chain
   ├─ Step 4 Comment watch  ── night shift patrols the comment section; routine
   │        └─ replies auto-drafted, sensitive/complaint cases escalate to humans (fence)
   └─ Step 5 Data review    ── 8:30 report on reach/engagement/conversion; winning plays
            └─ distilled into new skills by awareness — the team's "content instincts"
               settle into organizational memory
```

> AI video creation works the same way: script → storyboard → asset generation →
> publishing schedule → comment ops. Every step has an actor, an authorization,
> a result, and a trace — a content team's production pipeline *is* a Quest pipeline.

### 5.2 Safety rules of the marketplace

- **Installing a skill binds its fences; uninstalling revokes them** — conflicts go to approval, never silently pass
- **Industry-level listing requires desensitization** (`desensitized=true`); otherwise blocked, no downgrade allowed
- **Production accepts signed whitelist only**: official + team at v1; all other sources rejected and logged
- **Self-built skills must dry-run first**: replay real historical actions to preview; no preview trace, no install

### 5.3 Zero-code skill authoring (forge)

State three elements in natural language — **trigger** (when), **steps** (how), **boundary** (never-do) — and the system generates a standard SKILL.md draft under version management; regenerating bumps the version automatically.

---

## 6. Runtime foundation: a DeepSeek Harness best practice

WorkLoom doesn't reinvent the agent runtime — it **stands on the shoulders of DeepSeek Harness (dsh)** and concentrates all engineering firepower on the enterprise moat.

### 6.1 Dual-track architecture

```
┌─────────────────────────────────────────────────┐
│  L2  Self-built nine-domain moat (WorkData /      │
│       fence-engine / im-channels / inspection /   │
│       model-router / night-shift / review-console │
│       / skills / bundles / tenancy)               │
├─────────────────────────────────────────────────┤
│  L1  DeepSeek Harness (vendor/dsh, MIT)           │
│       Agent runtime foundation: loop / tools /    │
│       model routing / sessions / persistence /    │
│       plugins (cordis)                            │
└─────────────────────────────────────────────────┘
```

**Why not self-build the foundation?** Agent loops, tool scheduling, and model adapters commoditize fast — building with the open community beats closed-door reinvention, and dsh is maintained by the DeepSeek team. **Why must the nine domains be self-built?** WorkData, fences, audit, and night-shift scheduling sit directly against a company's money and data — that is where WorkLoom's value lives, and it must be fully owned.

### 6.2 Consuming dsh through precise seams

| Capability | dsh component | WorkLoom usage |
|---|---|---|
| Agent loop | dsh-agent-loop |底层循环 of the squad execution engine |
| Tool presentation | dsh-agent-tool-presentation | Fence interception takes effect before tool calls |
| Model adaptation | dsh-agent-default-model + model-router | Multi-model routing: cost / latency / task type |
| Plugin system | cordis | Channel plugin (dsh-im) mounts as a plugin |
| Instructions | dsh-agent-instructions | Squad SOPs injected into agent context |
| Persistence seam | dsh session persistence | Event bridge settles into WorkData's event store |

### 6.3 Giving back: the dsh-im channel plugin

WorkLoom extracted its IM channel adapter as a standalone dsh plugin, [`vendor/dsh-im`](vendor/dsh-im) (MIT) — any dsh app can use it to connect agents to IM channels. Our gift back to the dsh ecosystem.

---

## Architecture

<p align="center"><img src="docs/images/architecture.png" alt="WorkLoom system architecture" width="88%"/></p>

Five layers, top to bottom: **Experience** (bridge web / IM channels / Mac desktop bundle) → **Service** (Hono + tRPC v11 with PG row-level security) → **Capability** (self-built nine-domain moat, with the WorkData data brain as the core foundation) → **Runtime foundation** (DeepSeek Harness via seam adapters) → **Data** (PostgreSQL 17 + pgvector; five-element events, append-only + hash chain).

## Business loop

<p align="center"><img src="docs/images/business-loop.png" alt="WorkLoom core business loop" width="88%"/></p>

**Set course → fence verdict → squad executes → night watch → 08:30 battle report → captain decides** — a six-node loop, with "calibration write-back" and "sedimentation" feedback loops making every collaboration teach the system more about your business. A safety floor (emergency brake / black box / failure-to-human) catches every anomaly.

---

## Get started in 3 minutes (Mac)

1. **Download** `WorkLoom-macOS.zip` from [Releases](https://github.com/geniusdapeng-collab/workloom-im/releases) (~208 MB, sha256 included).
2. **Unzip and drag to Applications.** On first launch, if Gatekeeper prompts, click "Open Anyway" once in System Settings → Privacy & Security — the only manual authorization in the whole journey.
3. **Double-click WorkLoom.app.** The launcher does everything: embedded PostgreSQL 17 + pgvector init, migrations, service boot, bridge opens. No dependencies, no command line.

> Requires macOS 13 Ventura+ on Apple Silicon. Intel build coming later.

## User documentation (downloads with the code)

| Doc | For | Contents |
|---|---|---|
| [门店店长使用指南](docs/01-门店店长使用指南.md) | Store managers | Install → configure → daily use, zero jargon (中文) |
| [新客户首次接入完整流程](docs/02-新客户首次接入完整流程.md) | New customers, any industry | Generic onboarding, ~30 min (中文) |
| [功能清单（用户版）](docs/03-功能清单-用户版.md) | Everyone | Full feature list by scenario (中文) |
| [测试套件用例清单](docs/SUITE.md) | Developers / AI assistants | All 371 scenario cases, exported from the suite runner (中文) |
| [架构决策记录](docs/DECISIONS.md) | Developers | ADRs — why things are designed this way, incl. rejected options (中文) |
| [审计记录](docs/AUDIT.md) | Developers / security | Seven audit rounds: findings, root causes, fixes, gate evidence (中文) |

## Developer quickstart

Requirements: Node 24 LTS (pnpm 10 via corepack) + PostgreSQL 17 + pgvector 0.8.

```bash
git clone https://github.com/geniusdapeng-collab/workloom-im.git
cd workloom-im
corepack enable && pnpm install && cp .env.example .env

# DB init (just database + extension; migrate auto-creates the app/gateway roles and grants)
psql -U postgres -c "CREATE DATABASE workloom;"
psql -U postgres -d workloom -c "CREATE EXTENSION vector;"
pnpm db:migrate && pnpm db:seed   # 5 migrations + demo seed (idempotent, re-runnable)

# Quality gates (exactly what CI ci-gate runs on every push)
pnpm typecheck         # repo-wide typecheck
pnpm test              # vitest 168 (base 152 + runtime 12 + shared 4)
RUN_DB_TESTS=1 pnpm -C packages/base test   # PG integration tests (skipped by default)
pnpm db:verify-chain   # hash-chain recomputation (tamper detection)
pnpm suite             # 371 scenario cases (service 344 + HTTP E2E 27)
pnpm demo              # end-to-end demo play
pnpm doctor            # environment self-check

# Daily development
pnpm dev               # server(:8787) + web(:5173); demo login: pick "王店长"
```

Layout: `apps/{server, web, site, desktop}` + `packages/{shared, db, base, runtime}` + `bundles/` (industry packs) + `vendor/{dsh, dsh-im}`, a pnpm monorepo. Core foundation: **`packages/base/workdata` (the WorkData data brain)**. Full 371-case list: [`docs/SUITE.md`](docs/SUITE.md); CI gates: `.github/workflows/ci.yml`.

## Security design

- **Data sovereignty**: local-first; all business data in on-prem PostgreSQL with RLS multi-tenant isolation
- **WorkData event store**: append-only + hash chain — tamper-proof audit
- **Three-level fences**: auto / approval / forbidden; money- and data-touching actions require approval by default
- **One-tap emergency brake**: the tower can pause all agents at any time
- **License hygiene**: vendor dsh / dsh-im are MIT; the main repo is Apache-2.0

## Roadmap

- ✅ Current: one-click Mac desktop bundle + website + CI quality gates (371 scenario cases + hash-chain verification on every push)
- 🔜 Intel Mac / Windows builds
- 🔜 Skill marketplace industry tier (desensitization review pipeline + cross-org installs)
- 🔜 More domain bundles (social-media marketing, AI video & content creation, F&B, retail, property)
- ✅ dsh 0.1.1-rc.1 integrated (Codex / Claude Code as installable subagents; E6 dsh-gate green)
- 🔜 Continuous dsh upstream tracking (upgrade on ANY new release incl. pre-releases, with seam regression)

## Acknowledgements

- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`@deepseek-ai/dsh`, upstream `deepseek-ai/deepseek-harness`) — agent runtime foundation (MIT)
- [pgvector](https://github.com/pgvector/pgvector) — semantic retrieval for organizational memory
- Hono / tRPC / React / Vite — excellent engineering foundations

## License

[Apache-2.0](LICENSE) © WorkLoom. vendor/dsh and vendor/dsh-im remain under their own MIT licenses.
