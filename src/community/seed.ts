import type { Channel } from './types.ts';

type SeedChannel = Omit<Channel, 'id' | 'createdAt' | 'createdBy'>;

/**
 * The channels a brand-new instance opens with.
 *
 * They are seeded rather than left empty because an empty community is a dead
 * community — people need somewhere obvious to put a first message. The three
 * kinds are represented deliberately: a place to ask for help, a place to
 * belong to something, and a place to simply be around other people.
 */
export const SEED_CHANNELS: SeedChannel[] = [
  // ---- help: someone has a problem and wants an experienced answer ----
  {
    slug: 'home-repair',
    name: 'Home & Repair',
    kind: 'help',
    description:
      'Leaks, drafts, dead outlets, mystery noises. Describe the problem, add what you have already tried.',
    topics: ['plumbing', 'electrical', 'carpentry', 'hvac', 'appliances', 'roofing'],
  },
  {
    slug: 'worth-it',
    name: 'Is It Worth Fixing?',
    kind: 'help',
    description:
      'Repair or replace? Attach a price estimate from a photo, then let people who own the same thing weigh in.',
    topics: ['appraisal', 'repair-vs-replace', 'appliances', 'electronics', 'furniture'],
  },
  {
    slug: 'garden-yard',
    name: 'Garden & Yard',
    kind: 'help',
    description: 'What is eating the tomatoes, when to prune, why the lawn has a bald patch.',
    topics: ['gardening', 'landscaping', 'pest-control', 'trees'],
  },
  {
    slug: 'tech-help',
    name: 'Tech Help',
    kind: 'help',
    description: 'Wifi that drops, a laptop that will not boot, a phone nobody can explain.',
    topics: ['computers', 'phones', 'wifi', 'smart-home', 'printers'],
  },
  {
    slug: 'borrow-a-tool',
    name: 'Borrow a Tool',
    kind: 'help',
    description:
      'Nobody needs to own a tile saw. Ask for the thing you need for an afternoon, or offer what is in your garage.',
    topics: ['tools', 'lending', 'diy'],
  },
  {
    slug: 'money-and-paperwork',
    name: 'Money & Paperwork',
    kind: 'help',
    description:
      'Quotes that look wrong, forms that make no sense, bills nobody can read. General experience only — not professional advice.',
    topics: ['contractors', 'quotes', 'insurance', 'utilities'],
  },

  // ---- group: standing public groups around a shared interest ----
  {
    slug: 'cooks-table',
    name: "The Cook's Table",
    kind: 'group',
    description: 'What you made this week, what went wrong, and who wants the extra portion.',
    topics: ['cooking', 'baking', 'preserving'],
  },
  {
    slug: 'makers',
    name: 'Makers & Menders',
    kind: 'group',
    description: 'Sewing, woodwork, repair cafés. Bring the broken thing and the half-finished thing.',
    topics: ['sewing', 'woodworking', 'repair-cafe', 'crafts'],
  },
  {
    slug: 'new-parents',
    name: 'New Parents',
    kind: 'group',
    description: 'The 3am group. Questions, hand-me-downs, and company from people in the same year.',
    topics: ['parenting', 'childcare'],
  },
  {
    slug: 'book-club',
    name: 'Book Club',
    kind: 'group',
    description: 'One book a month, discussed in the open. Latecomers always welcome.',
    topics: ['books', 'reading'],
  },

  // ---- social: getting people who are alone into the same room ----
  {
    slug: 'front-porch',
    name: 'The Front Porch',
    kind: 'social',
    description:
      'No agenda, no problem to solve. Say hello, say how the day went. Somebody will answer.',
    topics: ['conversation'],
  },
  {
    slug: 'check-in',
    name: 'Daily Check-In',
    kind: 'social',
    description:
      'One message a day, however small, so that nobody here goes a week unnoticed. Waving at a quiet member is encouraged.',
    topics: ['wellbeing', 'company'],
  },
  {
    slug: 'walks-and-coffee',
    name: 'Walks & Coffee',
    kind: 'social',
    description:
      'Low-effort meetups in public places. Post a time and a bench; anyone can RSVP.',
    topics: ['meetups', 'walking', 'coffee'],
  },
  {
    slug: 'sunday-supper',
    name: 'Sunday Supper',
    kind: 'social',
    description: 'Shared meals. Host a table, or take a seat at someone else’s.',
    topics: ['meetups', 'meals'],
  },
];
