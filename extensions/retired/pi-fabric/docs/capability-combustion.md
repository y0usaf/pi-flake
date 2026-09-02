# Capability combustion: the math behind fabric advisory hints

The advisor works with a limited hint budget. One session branch permits three hints by default. Each fired hint burns its matched namespace for the rest of that branch.

Think of a capability as a battery cell. One hint spends its charge. A false fire takes useful information away from later turns. The advisor fires when the prompt carries enough evidence for likely tool use.

The code lives in `src/core/capability-advisory.ts`.

## How the advisor scores a prompt

The index groups tools by source namespace. For each tool it reads the tool name plus the first sentence of the description. Later instruction sentences tend to hold common request words, so the index skips them.

A description tail can hold words such as "understand" and "how." Words like these once tied a question about `docs/heat-diffusion.md` to fal.ai. The first sentence states a narrower identity for each tool.

For each unburned source, the advisor computes a raw score:

$$
s(p, j) = \sum_{w \in W(p)} \max_{t \in R(w) \cap T(j)} \frac{1}{\mathrm{df}(t)}, \qquad \mathrm{df}(t) = \Bigl|\{ j : t \in T(j) \}\Bigr|
$$

$W(p)$ holds the unique written words of prompt $p$. Together, the CamelCase atoms and the full spelling of word $w$ form $R(w)$. For source $j$, the indexed terms live in the set $T(j)$.

One written word supplies one evidence unit. From the valid readings, the scorer selects the rarest. Letter case changes only the spelling form. Readings and weight stay unchanged, so every case form scores the same.

The term weight is $1/\mathrm{df}$. In a small catalog, a logarithmic idf can fall below one and starve a valid pair. Under the selected scale, a source-unique term always receives one full quantum.

The raw source score $s(p,j)$ opens the scatter lane. For a phrase, one tool surface sets the score. The advisor calculates this value:

$$
s_\phi(p,j)=\max_{u \in U(j):L(p,u)} s(p,u), \qquad
\hat{s}(p,j)=
\begin{cases}
s_\phi(p,j) & s_\phi(p,j) \geq \theta \\
\min(s(p,j),q) & \text{otherwise.}
\end{cases}
$$

$U(j)$ denotes the tool surfaces of source $j$. When a local word pair sits on surface $u$, $L(p,u)$ becomes true for prompt $p$. The effective score $\hat{s}$ controls the fire path, the source rank, and the score shown in advisory details.

All phrase mass belongs to one surface. Extra tools can raise the raw source score. The scatter cap holds their effective score at $q$.

## Rules before a fire

### Remove skill envelopes

Pi can place loaded skills into the prompt inside XML regions. Before making tokens, the matcher cuts out the `<available_skills>` and `<skill>` regions. An open region that runs to the end of the prompt goes out as well.

### Reduce path terms

A word that occurs only inside a file path or a URL receives half a quantum. This rule covers text like `docs/heat-diffusion.md` and `worker.ts`. Alone, one path word falls below the default threshold. Two such words together supply one weak quantum.

The filename matcher works from an extension list. A brand domain such as `fal.ai` and a term that occurs in free prose both keep full prose weight.

### Require two written words

A Latin prompt needs two matched written words. One generic word on its own supplies zero heat. In a small catalog, this gate keeps out source-unique filler such as "project."

Source names carry one narrow exception. A label token with at least three letters can enter the weak lane on its own. Short tokens such as `ai` and `pi` stay silent. The script boundary rule gives the second exception.

### Bind a phrase to one tool

Two matched words form a phrase when both of these conditions hold:

1. Their positions sit at most $2\tau$ prompt survivors apart.
2. A single tool surface holds both terms.

The default window holds four survivors. Each tool surface receives its own score. Once a local surface clears $\theta$, the strongest such surface supplies $s_\phi$.

Terms that land on separate tools form scatter. Distant terms take the same lane. Scatter feeds at $\min(s,q)$ per turn. Whatever the raw mass and the source tool count, the cap stays at $q$.

### Check a script boundary

The advisor treats a prompt as mostly non-Latin when its non-Latin letter count exceeds its Latin word count. The check covers Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, and Thai text.

A single source-unique Latin word can fire on the first turn after it passes one of these checks:

1. The word names the source with a label token of at least three letters.
2. At least $1-1/\tau$ of the source tool surfaces contain the word.

The second check measures the topic of the source. On fal.ai, `model` appears on 5 of 11 surfaces. That share stays below one half, so `model とは何ですか` stays silent. At the default $\tau=2$, a word passes when it covers at least one half of the tools.

This route fires with the weak headline text. Every other furnace rule still applies.

### Reduce familiar session words

For each written word, the advisor stores a lowercase key. Use on adjacent turns counts as one continuous episode. A return after $\tau^2$ turns opens a new episode. After a gap of $\tau^3$ turns, the episode count resets to zero.

Each completed episode multiplies the term weight by $1/(1+e)$:

$$
w(t)=\frac{1}{\mathrm{df}(t)(1+e_w)}
$$

Ambient words that return after long gaps lose weight under this rule. A continuous weak signal keeps its full weight. Brand words of a source get the same protection. All casing forms share one episode key.

### Remove advisor echoes

The advisor remembers every word it emits. Later prompts no longer see those words in the evidence stream. A quote or a paste of the advisory then supplies zero heat to another namespace.

Custom messages hold the emitted text. On a process reload, the advisor rebuilds the word set from the current branch. A tree rewind drops the words that occurred only in the abandoned future.

### Make tokens

The tokenizer accepts Latin letters and digits. Each token starts with a letter and contains at least two characters. Other scripts supply context for the script boundary check.

The stopword set drops common English filler. It includes the question words `what`, `how`, `why`, `where`, `which`, and `who`. These words frame requests, so the filter strips their capability weight.

## How heat builds

Two values define the model:

| Value | Default | Meaning |
|---|---:|---|
| score quantum $q$ | 1 | weight carried by a source-unique term |
| memory scale $\tau$ | 2 turns | time scale behind heat and feedback |

The configured threshold is $\theta$, with 0.9 as its default. Every other constant derives from $q$ and $\tau$.

| Constant | Value | Formula |
|---|---:|---|
| heat retention $\alpha$ | 0.5 | $1-1/\tau$ |
| cool half-life | 1 turn | $\ln(1/2)/\ln(1-1/\tau)$ |
| weak band width $B$ | 1 | $q$ |
| smoke step | $0.25\theta$ | $\theta/\tau^2$ |
| smoke streak limit | 4 | $\tau^2$ |
| largest furnace raise | $\theta$ | $(\theta/\tau^2)\tau^2$ |
| default branch cap | 3 | $2\tau-1$ |
| phrase window | 4 survivors | $2\tau$ |
| scatter feed limit | 1 | $q$ |
| topic share | 1/2 | $1-1/\tau$ |
| feedback window | 2 turns | $\tau$ |
| episode gap | 4 turns | $\tau^2$ |
| episode reset gap | 8 turns | $\tau^3$ |
| familiar-word factor | $1/(1+e)$ | episode count $e$ |

Heat gauges the recent mean score. Smoke tracks whether hints lead to tool use. The smoke streak spans a $\tau^2$ range because its observed variance falls with the event count.

An unburned source enters one of these bands:

| Band | Condition | Action |
|---|---|---|
| strong | $s_\phi\geq\theta+B$ | fire on this turn |
| weak | $\theta\leq s_\phi<\theta+B$ | add surface heat |
| scatter | raw $s\geq\theta$ | add at most $q$ heat |

The headline tells the model how the source fired. A strong surface writes "matched your prompt." A heat crossing writes "might match your prompt." The `details.matches[].score` field holds $\hat{s}$.

Heat uses this exponential filter:

$$
W_k=(1-\alpha)\tilde{s}_k+\alpha W_{k-1}=(K_\tau*\tilde{s})_k
$$

$$
\tilde{s}_k=
\begin{cases}
s_\phi & s_\phi\geq\theta \text{ on one local surface} \\
\min(s,q) & s\geq\theta \text{ in the scatter lane} \\
0 & \text{otherwise.}
\end{cases}
$$

At $\tau=2$, each processed prompt keeps half of the prior heat. Hold a weak score of 1 and the heat reaches 0.9375 on its fourth continuous turn. With a score of 1.5, heat crosses the default threshold on turn 2.

Scatter approaches $W_\infty=q=1$. After one smoke event, its fire point rises to 1.125. Scatter then stays below that point.

A held weak signal with score $s$ uses this crossing time:

$$
k_{\text{fire}}=\left\lceil\frac{\ln(1-\theta_i/s)}{\ln(1-1/\tau)}\right\rceil
$$

At the default setting, an unrelated prompt halves the stored heat. A related prompt that arrives later picks up from the remaining value. Take `query results` with its fixture score of 1.5: it fires on its second continuous prompt. Insert one unrelated turn and the fire shifts to the third processed turn.

## How the transcript stores state

Durable advisor state lives in the transcript on the current branch.

A `pi-fabric-capability` custom message records the fired namespaces in `details`. Its `content` holds the words that echo removal needs. Each custom message also spends one unit of branch hint budget.

A captured tool call records organic discovery. The model has found the capability on its own, so the advisor burns that namespace.

At `session_start` and `session_tree`, the advisor replays `ctx.sessionManager.getBranch()`. The replay swaps ash, emitted words, and the spent hint count for the values on that branch leaf.

```json
{ "namespace": "extension:pi-websearch", "origin": "fired", "at": "2026-08-10T16:00:00.000Z" }
{ "namespace": "extension:pi-fovea", "origin": "organic", "at": "2026-08-10T16:12:11.000Z" }
```

A fork inherits the records that exist before its fork point. A tree rewind restores the budget that abandoned hints spent. The same rewind removes their ash and their emitted words. A fresh session starts from an empty branch.

Heat, smoke, pending feedback, and familiar-word episodes stay transient. At a session or tree boundary, the runtime clears them before it replays the durable state.

## How smoke changes the fire point

One advisory event can name up to two namespaces. A tool call from either namespace marks the event as used.

The event stays open for $\tau$ `turn_end` points. At the default value, the window spans its own fire turn plus the following turn. An unused event adds one smoke unit after the second point closes.

The smoke streak raises the weak fire point:

$$
\theta_i=\theta\left(1+\frac{n}{\tau^2}\right), \qquad 0\leq n\leq\tau^2
$$

A used event clears the streak. An expired one pushes it up by one. When windows overlap, events resolve in their fire order. The streak limit holds $\theta_i$ at or below $2\theta$.

A tool call that lands after the $\tau$ window burns organic ash. A completed smoke event keeps its earlier result. Strong surface evidence can fire at every smoke level.

Smoke lives in runtime memory for the active branch view. Transcript replay resets it to zero.

## How the branch cap works

`maxPerSession` sets the hint limit for the current branch. The default value is 3. During replay, each advisory custom message counts as one spent unit. A process reload keeps the spent count. A rewind past a hint returns that unit.

Ash blocks a burned namespace. The branch cap limits the total hint count.

## Measured behavior matrix

These tests run against a live-shaped catalog with 11 fal.ai tools and several extension sources. The threshold keeps its default value.

In the table, `tN` marks the fire turn for one repeated prompt. The words `weak` and `strong` name the headline register.

| ID | Evidence | First prompt | Repeated prompt | With smoke | After burn | Rule |
|---|---|---|---|---|---|---|
| A | one surface with a strong phrase | fires, strong | n/a | fires | blocked | strong band |
| B | a weak phrase built from shared words | silent | t2, weak | t4 | blocked | heat |
| C | scatter at any raw mass | silent | t4, weak | blocked | blocked | scatter cap |
| D | a single generic word | silent | blocked | blocked | n/a | two-word gate |
| E | a lone source brand | silent | t4, weak | blocked | blocked | brand lane |
| F | a label token of two letters | silent | blocked | blocked | n/a | length gate |
| G | brand at a script boundary | fires, weak | n/a | fires | blocked | brand check |
| H | the word `model` at a script boundary | silent | blocked | n/a | n/a | topic share |
| I | source topic at a script boundary | fires, weak | n/a | fires | blocked | topic share |
| J | unmarked paraphrase of a tool identity | fires, strong | n/a | fires | blocked | open semantic case |
| K | adjacent words split across tools | silent | t4, weak | blocked | blocked | surface rule |
| L | no useful overlap | silent | blocked | blocked | blocked | tokenizer |
| M | path-only URL words, repeated | silent | t2, weak | blocked | blocked | path factor |
| N | topic drift interleaved between turns | silent | stays silent | blocked | n/a | heat decay |
| O | advisor text quoted back | blocked | blocked after reload | n/a | branch exact | echo set |
| P | a familiar word with shifting case | decays | blocked after episodes | blocked | n/a | episode factor |
| Q | weak local pair plus 32 tool hits | silent | t4, score 1 | blocked | blocked | surface score |
| R | a hint used on the next turn | pending | clean event | clears streak | fired ash | feedback window |
| S | process reload or tree rewind | exact replay | exact replay | transient reset | exact replay | transcript |

## Open semantic case

Row J holds an unmarked paraphrase of one tool identity sentence. That prompt builds a strong local surface, and every value the advisor can observe supports the capability match. User intent sits outside the prompt, the catalog, and the session state.

Take `based on what you recommend, create my playlist`. It can hit the same identity words as a direct tool request. The source of that sentence stays unknown. Ash caps this fire at one slot on the branch. Later weak paths work from the smoke result.

A semantic model could infer the source and the intent of that sentence. The current model works from deterministic catalog and session data alone.

A tool call that lands after the $\tau$ feedback window raises an open question about its cause. The advisor records the call as organic use. The completed smoke result stands as before.

## Configuration

| Setting | Purpose |
|---|---|
| `capture.advisory.mode` | controls hint visibility |
| `capture.advisory.threshold` | sets the base fire point $\theta$ |
| `capture.advisory.maxPerSession` | sets the branch hint limit |
| `capture.advisory.budget` | sets the advisory text limit in tokens |

## Proxy contract (not this furnace)

Skill envelopes that name captured tools (`fovea_sketch`, `ask_user_question`) are ambient instructions, not user intent. The matcher already cuts those regions out, so they cannot ignite a hint.

A separate `pi-fabric-proxy` custom message may remind the model that those bare names are `extensions.*` calls inside `fabric_exec`. That message does not increment `maxPerSession`, does not enter the echo set, and does not burn ash. Replay restores only the per-name "already reminded" set. User prose outside the envelope still belongs to this furnace or to silence.
