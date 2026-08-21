---
name: creative-theme-generator
description: >
  Converts any user input into structured creative themes for AI video generation.
  Handles: natural language descriptions, keywords, long-form text extraction,
  partial fields, random generation, and batch test tasks.
  Outputs standardized 12-field JSON (task_id, type, theme, description, duration_sec,
  creative_style, tone, dialogue_requirement, visual_style, special_notes,
  target_audience, difficulty) with intelligent field completion and quality checks.
  Use when: user wants a video theme/idea, provides vague or rich input, pastes
  novel/script text, requests random ideas, or needs structured test tasks for
  AI video systems.
---

# Creative Theme Generator

Transform any user input into production-ready creative themes for AI video generation.

## Core Workflow

```
User Input → [Input Parser] → Field Extraction → [Field Completer] → [Quality Check] → JSON Output
                ↓                    ↓
         5 scene types         12 standard fields
         (see input-parsing)    (see field-spec)
```

### Step 1: Parse User Input

Identify which of the 5 input scenes applies:

| Scene | Input Pattern | Action |
|-------|--------------|--------|
| A | Natural language description | Keyword extraction + field mapping |
| B | Single keyword/phrase | Semantic expansion |
| C | No input / "random" / "give me" | Trigger random engine |
| D | Long-form text (>500 chars) | Extract core elements then map |
| E | Partial fields provided | Identify existing + fill missing |

For detailed parsing rules, scene classification, and long-text extraction procedures, read [references/input-parsing.md](references/input-parsing.md).

### Step 2: Extract and Complete 12 Standard Fields

For each of the 12 fields, determine if user provided it. If missing, apply completion rules:

| Field | User Provided? | Completion Source |
|-------|---------------|-------------------|
| task_id | Never | Auto-generate {batch}-{seq} |
| type | Sometimes | Keyword match against type library |
| theme | Sometimes | Extract from description or generate |
| description | Sometimes | Condense/expand or auto-generate |
| duration_sec | Sometimes | Parse number or derive from difficulty |
| creative_style | Rarely | Derive from type + difficulty ranges |
| tone | Sometimes | Map emotion word to standard lexicon |
| dialogue_requirement | Sometimes | Expand user's hint or type default |
| visual_style | Sometimes | Expand to film references + art direction |
| special_notes | Rarely | Generate from pressure anchors (≥3 items) |
| target_audience | Rarely | Derive from type |
| difficulty | Sometimes | Map keyword or count pressure anchors |

For complete field definitions, completion rules, type library, and emotion mapping, read [references/field-spec.md](references/field-spec.md).

### Step 3: Apply Pressure Anchors (Technical Difficulty Markers)

Select 1-3 pressure anchors (PA) that define the technical challenges. Each PA represents a specific hard problem for AI video systems:

- PA-01 Physical simulation (fluids, rigid bodies, cloth)
- PA-02 Micro-expressions / performance
- PA-03 Crowd choreography
- PA-04 One-shot / long take
- PA-05 Scientific visualization
- PA-06 Cultural heritage accuracy
- PA-07 Zero-gravity / special physics
- PA-08 Music / beat synchronization
- PA-09 Non-linear narrative
- PA-10 Industry terminology precision
- PA-11 Biomechanics
- PA-12 Visual illusion / surreal

PA selection drives creative_style coefficient and special_notes content. For PA combinations, CSC derivation rules, and type-recommended film references, read [references/pressure-anchors.md](references/pressure-anchors.md).

### Step 4: Random Generation (when triggered)

If Scene C (no input / random request):

1. Randomly select from 6 primary categories (fiction, documentary, commercial, education, art, emotion)
2. Pick a secondary type within category
3. Randomly select 1-3 complementary PAs
4. Derive CSC from PA combination
5. Generate theme using formula: `[core imagery] + [conflict/twist] + [temporal/spatial constraint]`
6. Fill all fields via completion rules

For category library, secondary types, and generation examples, read [references/random-engine.md](references/random-engine.md).

### Step 5: Quality Self-Check

After generating each task, verify all 10 checkpoints:

- [ ] **Visual imagery test**: Can I form at least 3 clear visual images from reading?
- [ ] **Executability test**: Can an AI video system generate specific prompts from this?
- [ ] **User input coverage**: Are all user requirements reflected?
- [ ] **Completion quality**: Are auto-filled fields professional and reasonable?
- [ ] **Duration fit**: Can the described content fit the target duration?
- [ ] **Difficulty consistency**: Do special_notes match the difficulty level?
- [ ] **Dialogue precision**: Is there at least one "must-include line" or clear dialogue spec?
- [ ] **Reference film**: Does visual_style include at least 1 specific film reference?
- [ ] **PA linkage**: Do special_notes correspond to selected pressure anchors?
- [ ] **Audience match**: Does target_audience align with the type?

For JSON schema, batch output rules, and user interaction templates, read [references/output-format.md](references/output-format.md).

## Output Format

Standard single-task output:

```json
{
  "meta": {
    "version": "2.0",
    "generated_at": "2026-06-30",
    "total_tasks": 1,
    "batch_name": "用户定制生成",
    "purpose": "基于用户输入的定向创意主题生成"
  },
  "tasks": [
    {
      "task_id": "C-001",
      "type": "医疗急救",
      "theme": "创伤中心黄金10分钟",
      "description": "...",
      "duration_sec": 50,
      "creative_style": 0.55,
      "tone": "紧张压抑",
      "dialogue_requirement": "...",
      "visual_style": "...",
      "special_notes": "①... ②... ③...",
      "target_audience": "...",
      "difficulty": "极高"
    }
  ]
}
```

## Core Design Principles

1. **User-agnostic input handling** — What the user types matters less than what the system can extract
2. **Intelligent gap-filling** — What's unsaid should be completed professionally; what's said must be preserved
3. **Fault tolerance** — Handle garbled, multilingual, or contradictory input gracefully
4. **Proactive confirmation** — After generation, surface key fields and invite user adjustment
5. **Batch scalability** — Support 1 to N tasks with type diversity and difficulty gradient
6. **Specific references** — visual_style must include concrete film titles, never vague descriptions
