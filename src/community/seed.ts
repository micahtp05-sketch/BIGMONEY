import type { Channel } from './types.ts';

type SeedChannel = Omit<Channel, 'id' | 'createdAt' | 'createdBy'>;

/**
 * The rooms a brand-new instance opens with.
 *
 * Three kinds of room, and members can add to two of them:
 *
 *   help   — one room per trade. Anybody can ask; only people whose identity
 *            has been checked can answer, and the professionals in that trade
 *            are listed at the top. These are curated: a member cannot start a
 *            "Plumbers" room, a moderator can.
 *   group  — clubs. The ones here are examples; the point is that members
 *            start their own — a Sunday book club, a bike club, three people
 *            who want to walk on Tuesdays.
 *   social — plain company. Say hello, or meet up.
 *
 * Descriptions are held to ten words. Past that people stop reading the list
 * and start guessing.
 */
export const SEED_CHANNELS: SeedChannel[] = [
  // ---- professionals: one room per trade ----
  {
    slug: 'electricians',
    name: 'Electricians',
    kind: 'help',
    description: 'Wiring, sockets, fuse boards, lights, anything that sparks.',
    topics: ['electrician', 'electrical', 'wiring', 'lighting'],
  },
  {
    slug: 'plumbers',
    name: 'Plumbers',
    kind: 'help',
    description: 'Leaks, taps, drains, toilets, appliances that use water.',
    topics: ['plumber', 'plumbing', 'drains', 'appliances', 'bathrooms'],
  },
  {
    slug: 'heating',
    name: 'Heating & Gas',
    kind: 'help',
    description: 'Boilers, radiators, gas, hot water, staying warm.',
    topics: ['heating engineer', 'heating', 'hvac', 'boilers', 'gas'],
  },
  {
    slug: 'builders',
    name: 'Builders & Renovation',
    kind: 'help',
    description: 'Extensions, walls, kitchens, custom builds, big jobs.',
    topics: ['builder', 'building', 'renovation', 'carpentry', 'carpenter', 'kitchens', 'extensions'],
  },
  {
    slug: 'landscapers',
    name: 'Landscapers & Gardeners',
    kind: 'help',
    description: 'Gardens, lawns, trees, fences, patios, outside space.',
    topics: ['landscaper', 'landscaping', 'gardener', 'gardening', 'trees', 'fencing', 'patios'],
  },
  {
    slug: 'roofers',
    name: 'Roofers',
    kind: 'help',
    description: 'Roofs, gutters, flashing, leaks from above.',
    topics: ['roofer', 'roofing', 'gutters', 'chimneys'],
  },
  {
    slug: 'decorators',
    name: 'Painters & Decorators',
    kind: 'help',
    description: 'Painting, plastering, wallpaper, tiling, finishing a room.',
    topics: ['decorator', 'painter', 'painting', 'plastering', 'tiling'],
  },
  {
    slug: 'tech',
    name: 'Tech & Wifi',
    kind: 'help',
    description: 'Wifi, phones, laptops, printers, smart home, TVs.',
    topics: ['technician', 'computers', 'wifi', 'phones', 'printers', 'smart-home'],
  },

  // ---- groups: examples, because the point is starting your own ----
  {
    slug: 'book-club',
    name: 'Sunday Book Club',
    kind: 'group',
    description: 'One book a month. Latecomers welcome.',
    topics: ['books', 'reading'],
  },
  {
    slug: 'cycling',
    name: 'Bike Club',
    kind: 'group',
    description: 'Rides, routes, repairs, and someone to ride with.',
    topics: ['cycling', 'bikes'],
  },
  {
    slug: 'walking',
    name: 'Walking & Exercise',
    kind: 'group',
    description: 'Starting out, or starting again. Any pace.',
    topics: ['walking', 'running', 'exercise', 'fitness'],
  },
  {
    slug: 'cooking',
    name: 'Cooking',
    kind: 'group',
    description: 'What you made, and who wants some.',
    topics: ['cooking', 'baking'],
  },

  // ---- plain company ----
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
    description: 'Walks, coffee, meals. Post a time to meet.',
    topics: ['meetups', 'walking', 'coffee', 'meals'],
  },
];
