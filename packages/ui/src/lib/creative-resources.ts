export interface CreativeResource {
  id: string;
  name: string;
  kind: 'Guidance' | 'Components' | 'Inspiration' | 'AI tools';
  url: string;
  description: string;
  access: string;
}

/** Curated on 2026-10-22. Links are references, not silently installed integrations. */
export const CREATIVE_RESOURCES: CreativeResource[] = [
  {
    id: 'ponytail',
    name: 'Ponytail',
    kind: 'Guidance',
    url: 'https://github.com/DietrichGebert/ponytail',
    description:
      'Reuse what exists and keep implementations small. Useful for avoiding unnecessary code; it does not supply an art direction.',
    access: 'Repository; review license before reuse',
  },
  {
    id: 'anti-slop',
    name: 'Anti Slop',
    kind: 'Guidance',
    url: 'https://github.com/miqdadbadjuber/anti-slop',
    description: 'Review recurring generic patterns in interface design, copy and generated code.',
    access: 'Repository; review license before reuse',
  },
  {
    id: 'impeccable',
    name: 'Impeccable',
    kind: 'Guidance',
    url: 'https://github.com/pbakaus/impeccable',
    description:
      'Design guidance for defining a product direction and refining the finished interface.',
    access: 'Repository; review license before reuse',
  },
  {
    id: 'anti-ui-slop',
    name: 'Anti UI Slop',
    kind: 'Guidance',
    url: 'https://github.com/tuanphung2005/anti-ui-slop',
    description:
      'A separate UI-focused ruleset. Compare its constraints with your brief rather than combining conflicting rules.',
    access: 'Repository; review license before reuse',
  },
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    kind: 'Components',
    url: 'https://github.com/shadcn-ui/ui',
    description:
      'Own and adapt the component source. Start from accessible building blocks and make them fit your identity.',
    access: 'MIT component library',
  },
  {
    id: 'radix',
    name: 'Radix Primitives',
    kind: 'Components',
    url: 'https://github.com/radix-ui/primitives',
    description:
      'Accessible interaction primitives for dialogs, menus and other complex interface behaviors.',
    access: 'MIT component library',
  },
  {
    id: 'motion',
    name: 'Motion',
    kind: 'Components',
    url: 'https://github.com/motiondivision/motion',
    description:
      'Animation for React and JavaScript. Use motion to explain a change, with a reduced-motion alternative.',
    access: 'MIT library; optional paid products are separate',
  },
  {
    id: 'r3f',
    name: 'React Three Fiber',
    kind: 'Components',
    url: 'https://github.com/pmndrs/react-three-fiber',
    description:
      'A React renderer for Three.js. Consider it when a real 3D experience serves the idea.',
    access: 'MIT library; assets have their own licenses',
  },
  {
    id: 'awwwards',
    name: 'Awwwards',
    kind: 'Inspiration',
    url: 'https://www.awwwards.com/',
    description:
      'Explore expressive websites and the studios behind them. Study composition and interaction, then create your own interpretation.',
    access: 'Reference gallery; artwork is not licensed for copying',
  },
  {
    id: 'siteinspire',
    name: 'Siteinspire',
    kind: 'Inspiration',
    url: 'https://www.siteinspire.com/',
    description:
      'Find references by style, type and subject instead of starting from the same SaaS template.',
    access: 'Reference gallery; artwork is not licensed for copying',
  },
  {
    id: 'freight',
    name: 'Studio Freight',
    kind: 'Inspiration',
    url: 'https://studiofreight.com/',
    description: 'A studio reference for thoughtful digital identity and web experiences.',
    access: 'Studio portfolio; reference only',
  },
  {
    id: 'hf',
    name: 'Hugging Face Spaces',
    kind: 'AI tools',
    url: 'https://huggingface.co/spaces',
    description:
      'Discover interactive AI demos. Check each Space, model license and compute requirements before using it in your project.',
    access: 'Availability, model licenses and costs vary',
  },
];

export function resourceBrief(resource: CreativeResource): string {
  return `Help me create a distinctive interface for this project. Use ${resource.name} (${resource.url}) as a reference if you can access it. Its purpose: ${resource.description}\n\nFirst identify the audience, intended outcome and existing design system. Propose a specific visual direction and a short design brief: typography, palette, composition, imagery, interaction and mobile behavior. Preserve the project stack, cover loading/empty/error states, and verify the rendered result. Use references as inspiration and respect their licenses. Do not claim to have read, installed or connected a resource without checking. Explain any external dependency before adding it.`;
}
