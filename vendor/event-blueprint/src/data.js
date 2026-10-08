// ---------- Reference data ----------
const PATHS = [
  { id: 'twin', t: 'Bring an event online', d: 'It happened, or it is booked. Recreate it online with the real venue, programme and recordings.', k: 'Existing event' },
  { id: 'new', t: 'Design a new event', d: 'Start from an idea. Shape the concept, spaces and programme, then build it.', k: 'From an idea' },
  { id: 'both', t: 'New event, in person and online', d: 'Design it from scratch for a real venue and an online version at the same time.', k: 'Hybrid from day one' },
];
const FORMATS = ['In person', 'Hybrid', 'Virtual', 'Online world only'];
const GOALS = ['Educate', 'Launch something', 'Celebrate', 'Network and connect', 'Generate leads or sales', 'Raise funds', 'Build community', 'Recognise or award', 'Entertain', 'Align a team'];
const MOODS = ['Premium', 'Warm', 'Scientific', 'Bold', 'Calm', 'Playful', 'Futuristic', 'Heritage', 'Intimate', 'Energetic', 'Minimal', 'Festive', 'Natural', 'Corporate', 'Artistic', 'Regional and local'];
const LANGS = ['English', 'Arabic', 'French', 'Hindi', 'Urdu', 'Spanish', 'Mandarin'];
const FEATURES = ['Walk the venue in 3D', 'Watch live or recorded sessions', 'Talk to AI attendees', 'Meet real attendees as avatars', 'Visit booths or stands', 'Live Q&A and polls', 'Networking matchmaking', 'Certificates or credits', 'Buy tickets or products', 'Vote or judge', 'Photo moments and sharing', 'Challenges and leaderboards', 'On-demand library', 'Captions and translation'];
const ACCESS = ['Open link', 'Free registration', 'Paid ticket', 'Invite only', 'Company or member login'];
const DEVICES = ['Phone', 'Laptop', 'Tablet', 'Big screen or TV', 'VR headset'];
const A11Y = ['Captions', 'Arabic right-to-left', 'Screen reader friendly', 'Low bandwidth mode', 'Sign language', 'Large text'];
const REGULATED = ['None', 'Pharma or medical devices', 'Alcohol', 'Financial services', 'Gaming or betting', 'Other regulated'];
const SETTINGS = ['Hotel ballroom', 'Convention centre', 'Rooftop', 'Desert camp', 'Beach', 'Museum or gallery', 'Garden or park', 'Theatre', 'Stadium or arena', 'Industrial warehouse', 'Heritage site', 'Purely imaginary world'];
const SCALES = ['Intimate (under 100)', 'Medium (100 to 500)', 'Large (500 to 2,000)', 'Massive (2,000+)'];
const LOOKS = ['Elegant', 'Clean and precise', 'Warm and natural', 'High-tech', 'Luxury', 'Colourful', 'Monochrome', 'Industrial', 'Traditional', 'Editorial'];
const FOLDERS = [['01_Brief', 'Concept notes, briefs, past reports'], ['02_Venue', 'Floor plans (PDF or CAD), photos, 360 images, dimensions'], ['03_Programme', 'Agenda, run of show, abstracts or poster list'], ['04_Recordings', 'Videos named by space and moment, e.g. MainStage_Opening.mp4, plus captions'], ['05_Partners', 'Sponsor list with tiers, booth plan, approved artwork'], ['06_Brand', 'Guidelines, vector logos, fonts, key visuals'], ['07_People', 'Speaker bios and photos with consent, staff roles, FAQ'], ['08_Media', 'Music, sound, extra video, social assets with rights']];

// spaces: [name, purpose, capacity]; programme: [time, title, space, who]; segments: [label, pct]
const TYPES = [
  { id: 'summit', n: 'Corporate conference or summit', e: 'Keynotes, panels, breakouts, networking', reg: 'None',
    spaces: [['Arrival lobby', 'Welcome and badges', '400'], ['Main stage', 'Keynotes and panels', '500'], ['Breakout room 1', 'Deep dives', '80'], ['Breakout room 2', 'Deep dives', '80'], ['Partner showcase', 'Sponsor stands', '200'], ['Networking terrace', 'Meetings and drinks', '200']],
    prog: [['08:30', 'Arrival and breakfast', 'Arrival lobby', ''], ['09:30', 'Opening keynote', 'Main stage', 'CEO'], ['10:30', 'Panel discussion', 'Main stage', 'Moderator and panel'], ['12:00', 'Breakouts', 'Breakout room 1', 'Facilitators'], ['13:00', 'Lunch and networking', 'Networking terrace', ''], ['15:00', 'Closing and drinks', 'Main stage', 'Host']],
    segs: [['Senior leaders', 30], ['Managers', 40], ['Partners and clients', 20], ['Press', 10]], feats: ['Watch live or recorded sessions', 'Live Q&A and polls', 'Networking matchmaking', 'Meet real attendees as avatars'] },
  { id: 'launch', n: 'Product launch', e: 'A reveal moment, demos, press', reg: 'None',
    spaces: [['Arrival tunnel', 'Build anticipation', '300'], ['Reveal stage', 'The unveiling', '300'], ['Demo zone', 'Hands-on with the product', '150'], ['Press corner', 'Interviews and media', '30'], ['Lounge bar', 'Celebration', '300']],
    prog: [['18:30', 'Arrivals and teaser', 'Arrival tunnel', ''], ['19:15', 'Countdown and reveal', 'Reveal stage', 'Host and founder'], ['19:45', 'Demos open', 'Demo zone', 'Product team'], ['20:00', 'Press interviews', 'Press corner', 'Spokespeople'], ['20:30', 'Celebration', 'Lounge bar', 'DJ']],
    segs: [['Customers and fans', 40], ['Press and creators', 25], ['Partners and retail', 20], ['Team', 15]], feats: ['Watch live or recorded sessions', 'Walk the venue in 3D', 'Buy tickets or products', 'Photo moments and sharing'] },
  { id: 'expo', n: 'Trade show or expo', e: 'Halls of stands, seminars, matchmaking', reg: 'None',
    spaces: [['Entrance hall', 'Registration and wayfinding', '2000'], ['Exhibition hall 1', 'Stands', '3000'], ['Exhibition hall 2', 'Stands', '3000'], ['Seminar theatre', 'Talks on the floor', '150'], ['Business lounge', 'Buyer meetings', '120'], ['Food court', 'Breaks', '600']],
    prog: [['09:00', 'Doors open', 'Entrance hall', ''], ['10:00', 'Opening ribbon', 'Exhibition hall 1', 'Guest of honour'], ['11:00', 'Seminar programme', 'Seminar theatre', 'Speakers'], ['14:00', 'Buyer matchmaking', 'Business lounge', ''], ['18:00', 'Doors close', 'Entrance hall', '']],
    segs: [['Buyers', 45], ['Exhibitors', 30], ['Industry visitors', 20], ['Press', 5]], feats: ['Visit booths or stands', 'Networking matchmaking', 'Walk the venue in 3D', 'Buy tickets or products'] },
  { id: 'gala', n: 'Awards night or gala dinner', e: 'Red carpet, dinner, ceremony, entertainment', reg: 'None',
    spaces: [['Red carpet arrival', 'Photos and welcome', '400'], ['Reception', 'Drinks and canapés', '400'], ['Ballroom', 'Dinner and ceremony', '400'], ['Stage', 'Awards and performances', ''], ['After-party lounge', 'Music and dancing', '250']],
    prog: [['19:00', 'Red carpet', 'Red carpet arrival', 'Host'], ['19:30', 'Reception', 'Reception', ''], ['20:15', 'Dinner served', 'Ballroom', ''], ['21:00', 'Awards ceremony', 'Stage', 'Host and presenters'], ['22:30', 'After-party', 'After-party lounge', 'DJ']],
    segs: [['Nominees and winners', 25], ['Guests and partners', 50], ['Judges and VIPs', 15], ['Press', 10]], feats: ['Watch live or recorded sessions', 'Vote or judge', 'Photo moments and sharing', 'Meet real attendees as avatars'] },
  { id: 'training', n: 'Workshop or masterclass', e: 'Small groups, hands-on learning', reg: 'None',
    spaces: [['Welcome area', 'Check-in and coffee', '40'], ['Training room', 'Teaching and practice', '30'], ['Breakout pods', 'Group exercises', '8'], ['Demo station', 'Equipment or simulation', '10']],
    prog: [['09:00', 'Welcome and objectives', 'Training room', 'Lead trainer'], ['09:30', 'Module 1', 'Training room', 'Trainer'], ['11:00', 'Hands-on practice', 'Demo station', 'Facilitators'], ['13:00', 'Lunch', 'Welcome area', ''], ['14:00', 'Group case work', 'Breakout pods', ''], ['16:00', 'Assessment and certificates', 'Training room', 'Lead trainer']],
    segs: [['Learners', 85], ['Faculty', 15]], feats: ['Certificates or credits', 'Watch live or recorded sessions', 'Live Q&A and polls', 'On-demand library'] },
  { id: 'webinar', n: 'Webinar or virtual series', e: 'Online sessions over weeks or months', reg: 'None',
    spaces: [['Virtual lobby', 'Arrival and schedule', ''], ['Studio stage', 'Live sessions', ''], ['Discussion rooms', 'Small-group follow-up', ''], ['Library', 'Replays and resources', '']],
    prog: [['Week 1', 'Episode 1', 'Studio stage', 'Host and guest'], ['Week 2', 'Episode 2', 'Studio stage', 'Host and guest'], ['Week 3', 'Episode 3', 'Studio stage', 'Host and guest'], ['Week 4', 'Live Q&A finale', 'Studio stage', 'Panel']],
    segs: [['Core audience', 70], ['New audience', 30]], feats: ['Watch live or recorded sessions', 'Live Q&A and polls', 'On-demand library', 'Certificates or credits'] },
  { id: 'festival', n: 'Festival or concert', e: 'Stages, performers, food, crowds', reg: 'None',
    spaces: [['Gates', 'Entry and wristbands', '5000'], ['Main stage', 'Headliners', '5000'], ['Second stage', 'Emerging acts', '1500'], ['Food market', 'Food and drink', '1500'], ['Chill-out garden', 'Rest and shade', '600'], ['VIP deck', 'Hospitality', '200']],
    prog: [['16:00', 'Gates open', 'Gates', ''], ['17:00', 'Opening act', 'Second stage', 'Performer'], ['19:00', 'Support act', 'Main stage', 'Performer'], ['21:00', 'Headliner', 'Main stage', 'Headliner'], ['23:00', 'Close', 'Gates', '']],
    segs: [['Fans', 80], ['VIP and partners', 10], ['Creators and press', 10]], feats: ['Watch live or recorded sessions', 'Walk the venue in 3D', 'Photo moments and sharing', 'Buy tickets or products'] },
  { id: 'sports', n: 'Sports event', e: 'Competition, spectators, hospitality', reg: 'None',
    spaces: [['Fan zone', 'Activities before the match', '3000'], ['Arena or field', 'The competition', '10000'], ['Hospitality boxes', 'Partners and VIPs', '200'], ['Media centre', 'Press', '80']],
    prog: [['14:00', 'Fan zone opens', 'Fan zone', ''], ['16:00', 'Warm-up', 'Arena or field', 'Teams'], ['17:00', 'Kick-off', 'Arena or field', ''], ['19:00', 'Trophy presentation', 'Arena or field', 'Guest of honour']],
    segs: [['Fans', 85], ['Partners and VIP', 10], ['Media', 5]], feats: ['Watch live or recorded sessions', 'Challenges and leaderboards', 'Photo moments and sharing', 'Buy tickets or products'] },
  { id: 'community', n: 'Community or cultural event', e: 'Talks, food, crafts, families', reg: 'None',
    spaces: [['Welcome tent', 'Information', '200'], ['Main stage', 'Performances and talks', '500'], ['Craft and heritage area', 'Activities', '200'], ['Food stalls', 'Local food', '400'], ['Family zone', 'Children activities', '150']],
    prog: [['10:00', 'Opening', 'Main stage', 'Host'], ['11:00', 'Workshops and crafts', 'Craft and heritage area', 'Artisans'], ['13:00', 'Food and music', 'Food stalls', ''], ['16:00', 'Performances', 'Main stage', 'Performers']],
    segs: [['Families', 50], ['Residents', 35], ['Visitors', 15]], feats: ['Walk the venue in 3D', 'Photo moments and sharing', 'Watch live or recorded sessions', 'Captions and translation'] },
  { id: 'private', n: 'Wedding or private celebration', e: 'Ceremony, dinner, celebration', reg: 'None',
    spaces: [['Arrival garden', 'Welcome drinks', '250'], ['Ceremony space', 'The ceremony', '250'], ['Dinner hall', 'Dinner and speeches', '250'], ['Dance floor', 'Celebration', '250']],
    prog: [['17:00', 'Guests arrive', 'Arrival garden', ''], ['18:00', 'Ceremony', 'Ceremony space', ''], ['19:30', 'Dinner and speeches', 'Dinner hall', ''], ['21:30', 'First dance and party', 'Dance floor', 'DJ or band']],
    segs: [['Family', 50], ['Friends', 45], ['Others', 5]], feats: ['Watch live or recorded sessions', 'Photo moments and sharing', 'Meet real attendees as avatars'] },
  { id: 'exhibition', n: 'Exhibition, museum or gallery', e: 'Rooms of works, a story, a route', reg: 'None',
    spaces: [['Entrance and story wall', 'Introduction', '100'], ['Gallery 1', 'First chapter', '80'], ['Gallery 2', 'Second chapter', '80'], ['Immersive room', 'Signature experience', '40'], ['Shop and café', 'Exit', '60']],
    prog: [['All day', 'Self-guided route', 'Entrance and story wall', ''], ['11:00', 'Curator tour', 'Gallery 1', 'Curator'], ['15:00', 'Talk or performance', 'Immersive room', 'Guest']],
    segs: [['General visitors', 60], ['Students', 20], ['Collectors and press', 20]], feats: ['Walk the venue in 3D', 'Captions and translation', 'Talk to AI attendees', 'On-demand library'] },
  { id: 'hackathon', n: 'Hackathon or competition', e: 'Teams, challenges, judging', reg: 'None',
    spaces: [['Check-in', 'Teams arrive', '300'], ['Hack floor', 'Team tables', '300'], ['Mentor corner', 'Help desk', '30'], ['Pitch stage', 'Demos and judging', '300'], ['Rest area', 'Food and sleep', '100']],
    prog: [['Day 1 09:00', 'Kick-off and challenges', 'Pitch stage', 'Organisers'], ['Day 1 10:00', 'Hacking starts', 'Hack floor', 'Teams'], ['Day 1 16:00', 'Mentor clinics', 'Mentor corner', 'Mentors'], ['Day 2 14:00', 'Pitches', 'Pitch stage', 'Teams'], ['Day 2 17:00', 'Winners', 'Pitch stage', 'Judges']],
    segs: [['Participants', 80], ['Mentors', 10], ['Judges and partners', 10]], feats: ['Challenges and leaderboards', 'Vote or judge', 'Watch live or recorded sessions', 'Meet real attendees as avatars'] },
  { id: 'congress', n: 'Medical or scientific congress', e: 'Plenaries, parallel tracks, posters, exhibition', reg: 'Pharma or medical devices',
    spaces: [['Registration foyer', 'Arrival, badges, information', '600'], ['Plenary hall', 'Opening, keynotes, closing', '800'], ['Breakout hall A', 'Parallel track', '200'], ['Breakout hall B', 'Parallel track', '200'], ['Workshop room', 'Hands-on sessions', '60'], ['Poster gallery', 'Abstracts and e-posters', '150'], ['Exhibition', 'Partner booths and coffee', '500'], ['Networking lounge', 'Meetings and breaks', '150']],
    prog: [['08:00', 'Registration and coffee', 'Registration foyer', 'Organising team'], ['09:00', 'Opening plenary', 'Plenary hall', 'Chair and keynote speaker'], ['10:30', 'Coffee in the exhibition', 'Exhibition', ''], ['11:00', 'Parallel sessions', 'Breakout hall A', 'Session chairs'], ['13:00', 'Lunch and poster viewing', 'Poster gallery', ''], ['14:00', 'Workshops', 'Workshop room', 'Facilitators'], ['16:00', 'Closing plenary and awards', 'Plenary hall', 'Scientific chair']],
    segs: [['Specialists and consultants', 40], ['Trainees and residents', 25], ['Nurses and allied health', 20], ['Industry', 15]], feats: ['Watch live or recorded sessions', 'Walk the venue in 3D', 'Visit booths or stands', 'Certificates or credits', 'Talk to AI attendees', 'On-demand library'] },
  { id: 'other', n: 'Something else', e: 'Describe it in your own words', reg: 'None',
    spaces: [['Arrival', 'Welcome', ''], ['Main space', 'The main moment', ''], ['Social space', 'Meeting people', '']],
    prog: [['', 'Arrival', 'Arrival', ''], ['', 'Main moment', 'Main space', ''], ['', 'Social time', 'Social space', '']],
    segs: [['Main audience', 80], ['Guests', 20]], feats: ['Walk the venue in 3D', 'Meet real attendees as avatars'] },
];

const SECTIONS = [
  { id: 'start', n: 'Start', t: 'What are you making?' },
  { id: 'basics', n: 'Basics', t: 'The essentials' },
  { id: 'concept', n: 'Concept', t: 'The idea' },
  { id: 'spaces', n: 'Spaces', t: 'Spaces and zones' },
  { id: 'programme', n: 'Programme', t: 'Programme' },
  { id: 'people', n: 'People', t: 'People' },
  { id: 'avatars', n: 'Avatars', t: 'Avatars and what they can do' },
  { id: 'partners', n: 'Partners', t: 'Partners and sponsors' },
  { id: 'look', n: 'Venue and look', t: 'Venue and look' },
  { id: 'online', n: 'Online', t: 'The online experience' },
  { id: 'delivery', n: 'Delivery', t: 'Delivery' },
  { id: 'files', n: 'Files', t: 'Files' },
  { id: 'review', n: 'Blueprint', t: 'Your blueprint' },
];

// Examples follow the chosen event type, so nothing defaults to one industry.
const EXAMPLES = {
  _: { title: 'Spring Showcase 2027', host: 'Your company or organisation', purpose: 'Bring partners together to see what is coming next year and sign up early', audience: 'Who they are, where they come from, what they care about', success: '400 guests, 2,000 online visits, 50 sign-ups', feeling: 'Excited and part of something', venue: 'Venue and city' },
  summit: { title: 'Future of Work Summit 2027', host: 'Your company', purpose: 'Align 400 leaders on next year’s strategy and sign three partnerships', audience: 'Senior leaders, managers and key clients from across the region', success: '90% session attendance, 3 partnerships signed', feeling: 'Clear on the plan and proud to be part of it', venue: 'Hotel or convention centre, city' },
  launch: { title: 'Aurora SUV Reveal', host: 'Aurora Motors', purpose: 'Reveal the new SUV to buyers, press and dealers, and open pre-orders', audience: 'Car buyers, dealers, motoring press and creators', success: '1,000 pre-orders in 48 hours, 200 press pieces', feeling: 'They want one, now', venue: 'A landmark venue in the city' },
  expo: { title: 'Gulf Hospitality Expo 2027', host: 'The organising company', purpose: 'Connect 300 suppliers with hotel and restaurant buyers', audience: 'Buyers, owners, procurement teams and suppliers', success: '5,000 visitors, 2,000 booked meetings', feeling: 'Worth every minute: they found the right suppliers', venue: 'Exhibition centre, city' },
  gala: { title: 'Excellence Awards Night 2027', host: 'Industry association', purpose: 'Celebrate this year’s best work and the people behind it', audience: 'Nominees, partners, judges, VIPs and press', success: 'Every winner shared online, 95% guest satisfaction', feeling: 'Proud and moved', venue: 'Ballroom, city' },
  training: { title: 'New Managers Masterclass', host: 'Academy or training provider', purpose: 'Give 30 new managers skills they will use on Monday', audience: 'First-time managers from different departments', success: '90% pass the assessment, 4.5 out of 5 rating', feeling: 'Confident to lead', venue: 'Training centre, city' },
  webinar: { title: 'Monthly Insight Series', host: 'Your brand', purpose: 'Keep the community learning with one live episode a month', audience: 'Customers, followers and newcomers to the topic', success: '1,000 live viewers per episode, 40% come back', feeling: 'Informed and part of the conversation', venue: 'Online studio' },
  festival: { title: 'Desert Lights Festival', host: 'Festival promoter', purpose: 'Three nights of music and art under the stars for 10,000 fans', audience: 'Music fans aged 18 to 40, residents and visitors', success: 'Sold out, 50,000 social mentions', feeling: 'Euphoric', venue: 'Open-air site outside the city' },
  sports: { title: 'City Charity Run 2027', host: 'Sports club or charity', purpose: 'Bring 5,000 runners together and raise money for local causes', audience: 'Runners of all levels, families and sponsors', success: '5,000 finishers, AED 1 million raised', feeling: 'Tired and proud', venue: 'Route and finish area, city' },
  community: { title: 'Heritage Weekend', host: 'Cultural foundation or municipality', purpose: 'Celebrate local crafts, food and music with families', audience: 'Families, residents and visitors of all ages', success: '20,000 visitors over two days', feeling: 'Connected to their roots', venue: 'Heritage district, city' },
  private: { title: 'Sara and Omar’s Wedding', host: 'The two families', purpose: 'Celebrate with family and friends, here and abroad', audience: 'Family and friends, some joining from overseas', success: 'Everyone, near or far, feels they were there', feeling: 'Loved and welcomed', venue: 'Garden venue, city' },
  exhibition: { title: 'Light and Water', host: 'Museum or gallery', purpose: 'Tell the story of the collection in five rooms', audience: 'Visitors, students, collectors and press', success: '50,000 visitors, 10 minutes average per room', feeling: 'Curious and inspired', venue: 'Museum, city' },
  hackathon: { title: 'Smart City Hackathon', host: 'City innovation office', purpose: 'Teams build working prototypes for city challenges in 48 hours', audience: 'Developers, designers, students and mentors', success: '40 teams, 5 pilots funded', feeling: 'Energised by what they built', venue: 'Innovation hub, city' },
  congress: { title: 'Regional Science Congress 2027', host: 'Scientific society', purpose: 'Share new research and agree practical guidance for the region', audience: 'Specialists, researchers, trainees and industry', success: '1,500 attendees, 300 credit certificates', feeling: 'Up to date and ready to act', venue: 'Convention centre, city' },
};

// Avatars
const AV_STYLES = [['stylised', 'Stylised premium', 'Clean, characterful figures. Looks polished and runs well on phones.'], ['realistic', 'Realistic', 'Lifelike people. Most immersive, heaviest on phones.'], ['brand', 'Brand-led', 'Characters or a mascot in your brand style.'], ['light', 'Simple and light', 'Minimal figures for big crowds and slow connections.']];
const AV_DRESS = ['Business formal', 'Smart casual', 'National dress (kandura, abaya)', 'Evening wear', 'Casual', 'Sportswear', 'Uniforms for staff', 'Professional uniforms (e.g. white coats)', 'Costumes or themed'];
const AV_MIX = ['Mirror the real audience', 'Mostly regional', 'International mix'];
const AV_OWN = ['Pick from a set', 'Customise (skin, hair, outfit)', 'Create from a photo', 'Not needed'];
const AV_LIKENESS = ['Only with recorded consent', 'Never: roles only'];
const LANYARD_COLOURS = ['Red', 'Navy', 'Green', 'Gold', 'Silver', 'Black', 'White', 'Orange', 'Purple', 'Teal'];
const LANYARDS = {
  _: [['Guest', 'Navy'], ['VIP', 'Gold'], ['Staff', 'Red'], ['Press', 'Orange']],
  summit: [['Speaker', 'Red'], ['Attendee', 'Navy'], ['Partner', 'Green'], ['Organiser', 'Gold'], ['Press', 'Orange']],
  expo: [['Visitor', 'Navy'], ['Buyer', 'Gold'], ['Exhibitor', 'Green'], ['Organiser', 'Red'], ['Press', 'Orange']],
  gala: [['Nominee', 'Gold'], ['Guest', 'Navy'], ['Judge or VIP', 'Black'], ['Staff', 'Red'], ['Press', 'Orange']],
  festival: [['General admission', 'Navy'], ['VIP', 'Gold'], ['Artist', 'Purple'], ['Crew', 'Red'], ['Press', 'Orange']],
  sports: [['Participant', 'Navy'], ['VIP', 'Gold'], ['Official', 'Black'], ['Volunteer', 'Green'], ['Media', 'Orange']],
  hackathon: [['Participant', 'Navy'], ['Mentor', 'Green'], ['Judge', 'Gold'], ['Organiser', 'Red']],
  congress: [['Faculty', 'Red'], ['Delegate', 'Navy'], ['Exhibitor', 'Green'], ['Organiser', 'Gold'], ['Press', 'Orange']],
  private: [['Family', 'Gold'], ['Guest', 'Navy'], ['Staff', 'Red']],
};
const ABILITIES = [
  ['Moving', ['Sit on any seat', 'Queue at desks and bars', 'Take me there (auto-walk)', 'Follow a host or colleague', 'Lean at high tables', 'Use stairs and walk on stage']],
  ['Social', ['Wave', 'Handshake', 'Hand-on-heart greeting', 'Join conversation circles', 'Talk to AI attendees', 'Exchange contact cards', 'Photos together', 'Status on badge']],
  ['Sessions and shows', ['Raise hand to ask a question', 'Vote in polls', 'Applaud', 'Notes and bookmarks', 'Attendance for certificates or credits', 'Captions and language']],
  ['Stands and displays', ['Pick up brochures', 'Badge scan at stands', 'Book a meeting', 'Passport stamps', 'Zoom into posters or works', 'Try a product demo']],
  ['Hospitality', ['Order a coffee or drink', 'Find prayer room and restrooms', 'Cloakroom: change outfit']],
  ['Celebration', ['Walk up to the stage', 'Red carpet photo', 'Toast', 'Dance', 'Cheer and wave flags']],
  ['Inclusion', ['Wheelchair avatar', 'Seated mode', 'Large on-screen buttons']],
];
const NEEDS_CONSENT = ['Exchange contact cards', 'Badge scan at stands', 'Attendance for certificates or credits', 'Photos together'];
const ABILITY_DEFAULTS = (() => {
  const inc = ['Wheelchair avatar', 'Seated mode', 'Large on-screen buttons'], base = ['Take me there (auto-walk)', 'Wave', 'Handshake', 'Hand-on-heart greeting', 'Photos together', 'Find prayer room and restrooms', ...inc];
  return {
    summit: [...base, 'Sit on any seat', 'Queue at desks and bars', 'Join conversation circles', 'Exchange contact cards', 'Status on badge', 'Raise hand to ask a question', 'Vote in polls', 'Applaud', 'Notes and bookmarks', 'Captions and language', 'Book a meeting', 'Order a coffee or drink'],
    launch: [...base, 'Sit on any seat', 'Applaud', 'Cheer and wave flags', 'Red carpet photo', 'Try a product demo', 'Pick up brochures', 'Book a meeting', 'Order a coffee or drink'],
    expo: [...base, 'Queue at desks and bars', 'Follow a host or colleague', 'Exchange contact cards', 'Status on badge', 'Pick up brochures', 'Badge scan at stands', 'Book a meeting', 'Passport stamps', 'Try a product demo', 'Order a coffee or drink'],
    gala: [...base, 'Sit on any seat', 'Applaud', 'Walk up to the stage', 'Red carpet photo', 'Toast', 'Dance', 'Cloakroom: change outfit'],
    training: [...base, 'Sit on any seat', 'Raise hand to ask a question', 'Vote in polls', 'Notes and bookmarks', 'Attendance for certificates or credits', 'Captions and language', 'Join conversation circles'],
    webinar: ['Raise hand to ask a question', 'Vote in polls', 'Applaud', 'Notes and bookmarks', 'Attendance for certificates or credits', 'Captions and language', 'Large on-screen buttons'],
    festival: [...base, 'Queue at desks and bars', 'Follow a host or colleague', 'Cheer and wave flags', 'Dance', 'Order a coffee or drink'],
    sports: [...base, 'Sit on any seat', 'Queue at desks and bars', 'Cheer and wave flags', 'Applaud'],
    community: [...base, 'Join conversation circles', 'Applaud', 'Order a coffee or drink', 'Zoom into posters or works'],
    private: [...base, 'Sit on any seat', 'Toast', 'Dance', 'Applaud'],
    exhibition: [...base, 'Follow a host or colleague', 'Zoom into posters or works', 'Captions and language', 'Notes and bookmarks', 'Talk to AI attendees'],
    hackathon: [...base, 'Sit on any seat', 'Join conversation circles', 'Status on badge', 'Raise hand to ask a question', 'Vote in polls', 'Applaud', 'Walk up to the stage', 'Order a coffee or drink'],
    congress: [...base, 'Sit on any seat', 'Queue at desks and bars', 'Join conversation circles', 'Talk to AI attendees', 'Exchange contact cards', 'Status on badge', 'Raise hand to ask a question', 'Vote in polls', 'Applaud', 'Notes and bookmarks', 'Attendance for certificates or credits', 'Captions and language', 'Pick up brochures', 'Badge scan at stands', 'Book a meeting', 'Passport stamps', 'Zoom into posters or works', 'Order a coffee or drink'],
    other: [...base, 'Sit on any seat', 'Applaud'],
  };
})();
const DRESS_DEFAULTS = { summit: ['Business formal', 'Smart casual', 'National dress (kandura, abaya)', 'Uniforms for staff'], launch: ['Smart casual', 'National dress (kandura, abaya)', 'Uniforms for staff'], expo: ['Business formal', 'Smart casual', 'National dress (kandura, abaya)', 'Uniforms for staff'], gala: ['Evening wear', 'National dress (kandura, abaya)', 'Uniforms for staff'], festival: ['Casual', 'Uniforms for staff'], sports: ['Sportswear', 'Casual', 'Uniforms for staff'], private: ['Evening wear', 'National dress (kandura, abaya)'], congress: ['Business formal', 'Smart casual', 'National dress (kandura, abaya)', 'Uniforms for staff'], _: ['Smart casual', 'National dress (kandura, abaya)', 'Uniforms for staff'] };
const UPLOAD_CATS = ['Venue', 'Programme', 'Partners', 'Brand', 'People', 'Media', 'Other'];
