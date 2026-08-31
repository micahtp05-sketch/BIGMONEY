import type { Channel } from './types.ts';

type SeedChannel = Omit<Channel, 'id' | 'createdAt' | 'createdBy'>;

/**
 * The channels a brand-new instance opens with.
 *
 * They are seeded rather than left empty because an empty community is a dead
 * community — people need somewhere obvious to put a first message. There are
 * six of them, and the names are deliberately dull: a stranger should be able
 * to pick the right one without reading a word of the description. The three
 * kinds are all represented: a place to ask for help, a place to belong to
 * something, and a place to simply be around other people.
 *
 * Descriptions are held to ten words. Anything longer and people stop reading
 * the list and start guessing.
 */
export const SEED_CHANNELS: SeedChannel[] = [
  // ---- help: someone has a problem and wants an experienced answer ----
  {
    slug: 'home-repair',
    name: 'Home & Repairs',
    kind: 'help',
    description: 'Ask about leaks, wiring, heating, appliances, tools, repairs.',
    topics: [
      'plumbing', 'electrical', 'carpentry', 'hvac', 'appliances', 'roofing',
      'appraisal', 'repair-vs-replace', 'furniture',
      'tools', 'lending', 'diy',
      'contractors', 'quotes', 'insurance', 'utilities',
    ],
  },
  {
    slug: 'garden-yard',
    name: 'Garden & Yard',
    kind: 'help',
    description: 'Ask about plants, pests, lawns and trees.',
    topics: ['gardening', 'landscaping', 'pest-control', 'trees'],
  },
  {
    slug: 'tech-help',
    name: 'Tech Help',
    kind: 'help',
    description: 'Ask about phones, wifi, laptops, printers and TVs.',
    topics: ['computers', 'phones', 'wifi', 'smart-home', 'printers', 'electronics'],
  },

  // ---- group: standing public groups around a shared interest ----
  {
    slug: 'clubs',
    name: 'Clubs & Hobbies',
    kind: 'group',
    description: 'Cooking, crafts, books, parenting. Join one or start one.',
    topics: [
      'cooking', 'baking', 'preserving',
      'sewing', 'woodworking', 'repair-cafe', 'crafts',
      'parenting', 'childcare',
      'books', 'reading',
    ],
  },

  // ---- social: getting people who are alone into the same room ----
  {
    slug: 'chat',
    name: 'Chat & Check In',
    kind: 'social',
    description: 'Say hello. Tell us how your day went.',
    topics: ['conversation', 'wellbeing', 'company'],
  },
  {
    slug: 'meetups',
    name: 'Meetups',
    kind: 'social',
    description: 'Walks, coffee, shared meals. Post a time and place.',
    topics: ['meetups', 'walking', 'coffee', 'meals'],
  },
];
