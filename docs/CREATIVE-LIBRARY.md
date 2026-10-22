# Creative defaults

The product is for people with ideas, including people who do not write code.
Its main surface is a conversation and task progress; operational statistics stay
in the advanced dashboard. The v0.1 workspace preview uses the existing 0.2.x engine.

The built-in autonomous system prompt now asks agents to establish audience,
outcome, design direction, typography, color, composition, images, motion and mobile
behavior before frontend work. It requires accessible states and honest visual
verification. It explicitly rejects decorative dots, uppercase eyebrow labels and
redundant explanations. Project instructions and the user's brief remain authoritative.

The UI's Creative library ships with curated links and plain-language descriptions.
“Use in a goal” prepares a brief in the workspace; it never executes an installer,
scrapes a gallery, or claims an agent integration has been established.

## Research

The user's “Ponytale” was resolved to [Ponytail](https://github.com/DietrichGebert/ponytail).
It focuses on implementation restraint, rather than being a visual component kit.
[Anti Slop](https://github.com/miqdadbadjuber/anti-slop),
[Anti UI Slop](https://github.com/tuanphung2005/anti-ui-slop) and
[Impeccable](https://github.com/pbakaus/impeccable) are separately maintained guidance
projects, not interchangeable dependencies. Their full rulesets can conflict;
DaveCode has not combined or vendored them blindly.

Component references include [shadcn/ui](https://github.com/shadcn-ui/ui),
[Radix](https://github.com/radix-ui/primitives),
[Motion](https://github.com/motiondivision/motion) and
[React Three Fiber](https://github.com/pmndrs/react-three-fiber).
They are options for projects that need them, not mandatory runtime dependencies.

Discovery included Reddit's design and vibe-coding communities. Recommendations
were checked against original sources, including [Awwwards](https://www.awwwards.com/),
[Siteinspire](https://www.siteinspire.com/) and [Studio Freight](https://studiofreight.com/).
These are inspiration references, not reusable licensed artwork. Hugging Face's
[Spaces documentation](https://huggingface.co/docs/hub/spaces) describes its demo
hosting ecosystem; model licenses, access and compute costs vary per Space.

## Integration boundary

The existing HTTP API and CLI providers remain usable by agents. A universal MCP
server, one-click third-party skill installer, external gallery scraper and native
session bridge have not been implemented in this slice. Never label a resource as
installed or connected until a real lifecycle check succeeds.
