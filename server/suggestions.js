// Suggestion pool for players who freeze up staring at five empty boxes.
// Lives on the server, not in the client bundle, so a suggestion can be checked
// against what everyone else in the room has already written — two people
// picking the same phrase out of a shared list is otherwise very likely
// (25 draws from a few hundred entries collides more often than you'd guess).
//
// Deliberately a mix of concrete nouns, people, films, foods and short phrases:
// all three rounds have to work for every entry, and "Brushing your teeth" is
// far easier to act out than an abstract noun.
export const SUGGESTIONS = [
  'Pineapple', 'Roller coaster', 'Vacuum cleaner', 'Snowman', 'Karaoke', 'Bubble tea', 'Traffic jam',
  'Sunscreen', 'Escalator', 'Fire drill', 'Toaster', 'Hammock', 'Lighthouse', 'Wind turbine',
  'Shopping cart', 'Piggy bank', 'Rubber duck', 'Umbrella', 'Popcorn', 'Cactus', 'Igloo',
  'Trampoline', 'Sandcastle', 'Paper airplane', 'Alarm clock', 'Treadmill', 'Waterfall',
  'Chopsticks', 'Bowling alley', 'Hot air balloon', 'Vending machine', 'Bunk bed', 'Screwdriver',
  'Ferris wheel', 'Windshield wiper', 'Fortune cookie', 'Sock puppet', 'Bagpipes', 'Kayak',
  'Jellyfish', 'Penguin', 'Sloth', 'Octopus', 'Hedgehog', 'Flamingo', 'Chameleon', 'Meerkat',
  'Narwhal', 'Platypus', 'Peacock', 'Koala', 'Raccoon', 'Hummingbird', 'Walrus',

  'Brushing your teeth', 'Parallel parking', 'Losing your keys', 'Missing the bus',
  'Untangling headphones', 'Assembling furniture', 'Blowing out candles', 'Stubbing your toe',
  'Waiting on hold', 'Reading the terms and conditions', 'Sneezing in a quiet room',
  'Forgetting someone’s name', 'Running for the elevator', 'Overpacking a suitcase',
  'Burning the toast', 'Sleeping through an alarm', 'Getting a splinter', 'Hiccups',
  'Walking into a glass door', 'Cutting your own hair', 'Talking to yourself',
  'Pretending to be busy', 'Sending a text to the wrong person', 'Trying to fold a fitted sheet',

  'The Titanic', 'The Mona Lisa', 'Mount Everest', 'The Great Wall of China', 'The Eiffel Tower',
  'The Sahara Desert', 'Niagara Falls', 'The Grand Canyon', 'Stonehenge', 'The Sydney Opera House',
  'The Amazon rainforest', 'The Bermuda Triangle', 'The Leaning Tower of Pisa', 'Times Square',

  'Jurassic Park', 'The Lion King', 'Star Wars', 'Harry Potter', 'The Wizard of Oz', 'Titanic',
  'Finding Nemo', 'Ghostbusters', 'Jaws', 'The Matrix', 'Toy Story', 'Home Alone', 'Shrek',
  'Indiana Jones', 'Frozen', 'The Godfather', 'Back to the Future', 'Spider-Man',

  'Albert Einstein', 'Cleopatra', 'Shakespeare', 'Beethoven', 'Leonardo da Vinci', 'Napoleon',
  'Sherlock Holmes', 'Santa Claus', 'The Tooth Fairy', 'Dracula', 'Robin Hood', 'King Kong',
  'Elvis Presley', 'Marie Curie', 'Julius Caesar', 'Big Foot', 'The Loch Ness Monster',

  'Sushi', 'Spaghetti', 'Pancakes', 'Watermelon', 'Ice cream truck', 'Birthday cake', 'Hot pot',
  'Dumplings', 'Peanut butter', 'Cotton candy', 'Cheeseburger', 'Avocado toast', 'Espresso',
  'Marshmallow', 'Pickle', 'Croissant', 'Nachos', 'Ramen', 'Waffle', 'Mango',

  'Scuba diving', 'Skydiving', 'Yoga', 'Camping', 'Fishing', 'Gardening', 'Knitting',
  'Skateboarding', 'Ice skating', 'Rock climbing', 'Surfing', 'Juggling', 'Ballet', 'Bird watching',
  'Playing chess', 'Doing a jigsaw puzzle', 'Riding a unicycle', 'Sleepwalking', 'Snoring',

  'Thunderstorm', 'Rainbow', 'Earthquake', 'Volcano', 'Tornado', 'Solar eclipse', 'Northern lights',
  'Quicksand', 'Avalanche', 'Full moon', 'Shooting star', 'Fog',

  'Time travel', 'Déjà vu', 'A haunted house', 'A treasure map', 'A crystal ball', 'A magic carpet',
  'An invisible cloak', 'A message in a bottle', 'A secret handshake', 'A double rainbow',
  'A wild goose chase', 'A blind date', 'A surprise party', 'A road trip', 'A group photo',
];

function normalize(word) {
  return String(word ?? '')
    .trim()
    .toLowerCase();
}

/** What we've recently handed out per room, so two callers asking at the same
 *  moment don't get the same phrase. Submissions alone aren't enough: nothing
 *  is submitted yet at the point three bots (or three people tapping 🎲) ask
 *  together, so every one of them sees the same empty "taken" set.
 *  In memory only — it's a de-dup hint, not game state worth persisting. */
const recentlyOffered = new Map(); // roomCode -> normalized string[]
const OFFER_MEMORY = 60;

/** Drop a room's offer history when the room goes away. */
export function forgetRoom(roomCode) {
  recentlyOffered.delete(roomCode);
}

/** Pick up to `count` suggestions nobody in the room has used yet.
 *  Excludes every submitted word, `exclude` (the caller's own in-progress,
 *  not-yet-submitted boxes), and anything just offered to someone else.
 *  Returns fewer than asked only if the pool runs dry. */
export function suggestWords(room, count, exclude = []) {
  const taken = new Set();
  for (const words of Object.values(room.submissions ?? {})) {
    for (const word of words) taken.add(normalize(word));
  }
  for (const word of exclude) taken.add(normalize(word));
  taken.delete(''); // empty boxes aren't a collision

  const offered = recentlyOffered.get(room.code) ?? [];
  let pool = SUGGESTIONS.filter((word) => !taken.has(normalize(word)) && !offered.includes(normalize(word)));
  // the offer history is a nicety, never a reason to hand back nothing
  if (pool.length < count) pool = SUGGESTIONS.filter((word) => !taken.has(normalize(word)));

  const picked = [];
  // splice-from-a-copy = sampling without replacement, so one call never
  // hands the same player the same phrase twice
  for (let i = 0; i < count && pool.length > 0; i++) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  recentlyOffered.set(room.code, [...offered, ...picked.map(normalize)].slice(-OFFER_MEMORY));
  return picked;
}
