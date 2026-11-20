export const voicePresets = [
  {
    id: "friendly",
    name: "Friendly",
    description:
      "Upbeat and easygoing, with the odd emoji. Feels like a helpful regular staff member.",
    badge: "Recommended for cafés, retail & casual dining",
    instruction:
      "Use upbeat everyday language and occasional relevant emoji. Be helpful and conversational.",
  },
  {
    id: "formal",
    name: "Formal",
    description:
      "Polished and precise. Full sentences, no emoji. Suits fine dining and professional services.",
    badge: "Recommended for fine dining & professional services",
    instruction:
      "Use polished, precise full sentences. Be professional; avoid emoji and slang.",
  },
  {
    id: "warm",
    name: "Warm",
    description:
      "Gentle and personal. Makes every customer feel genuinely welcomed.",
    instruction:
      "Use gentle, welcoming, attentive language. Be personal without being intrusive.",
  },
  {
    id: "small",
    name: "Small text",
    description:
      "Short, casual, lowercase. Reads like the owner texting back personally.",
    badge: "Recommended for small, personal businesses",
    instruction:
      "Keep replies short and conversational, usually one or two lines. Prefer lowercase and natural texting language; preserve factual clarity and proper identifiers.",
  },
  {
    id: "playful",
    name: "Playful",
    description:
      "Fun and full of personality. Great for cafés, dessert bars and lifestyle brands.",
    instruction:
      "Use lively, playful everyday wording and occasional emoji. Keep complaints and safety matters calm, empathetic and direct.",
  },
  {
    id: "reassuring",
    name: "Reassuring",
    description:
      "Calm, patient and clear. Ideal for clinics and services where customers may feel anxious.",
    badge: "Recommended for clinics & healthcare",
    instruction:
      "Use calm, patient and clear wording. Acknowledge concerns without guaranteeing medical, service or safety outcomes.",
  },
] as const;
export const handoverPresets = [
  {
    key: "not_covered",
    title: "Not covered by your rules",
    description:
      "Nothing in your business rules answers it, so Pronto won’t guess.",
    locked: true,
    enabled: true,
    example: "Do you do full buyouts for 30 pax on NYE?",
  },
  {
    key: "conflicting_rules",
    title: "Conflicting rules",
    description: "Two of your rules disagree and haven’t been resolved yet.",
    locked: true,
    enabled: true,
    example: "Are you open on Monday?",
  },
  {
    key: "complaint",
    title: "Complaints & unhappy customers",
    description: "The customer is upset, disappointed or complaining.",
    enabled: true,
    example: "We waited 40 mins for our mains, really disappointed.",
  },
  {
    key: "asks_for_person",
    title: "Customer asks for a person",
    description: "They want to speak to the owner, manager or staff.",
    enabled: true,
    example: "Can I speak to the manager please?",
  },
  {
    key: "money",
    title: "Refunds, payments & deposit disputes",
    description:
      "Requests for money back, payment actions or disputed charges.",
    enabled: true,
    example: "Why wasn’t my deposit refunded?",
  },
  {
    key: "allergy",
    title: "Allergies & food safety",
    description: "Serious allergy or dietary-safety questions need the team.",
    enabled: true,
    example: "Is this safe for a severe shellfish allergy?",
  },
  {
    key: "large_group",
    title: "Large group bookings",
    description: "Bookings above a group size you set.",
    enabled: false,
    example: "Table for 14 this Friday?",
  },
  {
    key: "events",
    title: "Events, buyouts & partnerships",
    description:
      "Private events, collaborations, media or influencer requests.",
    enabled: false,
    example: "I run a food page and would love to collaborate!",
  },
] as const;
export type Industry = "restaurant" | "dental";
export type PresetId = (typeof voicePresets)[number]["id"];
export type Voice = {
  mode: "preset" | "custom";
  preset_id: PresetId;
  custom_notes: string[];
  custom_origin?: "conversation" | "upload" | "existing";
};
export type Handovers = {
  presets: Record<
    string,
    { enabled: boolean; params?: { min_group_size: number } }
  >;
  custom: Array<{ id: string; text: string }>;
};
export type Alerts = {
  whatsapp_enabled: boolean;
  whatsapp_number: string;
  email_enabled: boolean;
  email_address: string;
};
export const scenarios = {
  restaurant: {
    customer: "Jasmine",
    messages: [
      "Hi, can I book a table for 6 this Saturday at 7pm?",
      "Is there a corkage fee if we bring our own wine?",
      "We came last week and waited 40 mins for our mains. Pretty disappointed tbh.",
    ],
    preview: "Hi, can I change my booking to 8pm instead?",
  },
  dental: {
    customer: "Marcus",
    messages: [
      "Hi, do you have any slots for a cleaning next week? Preferably evening",
      "How much is scaling and polishing? Do you accept CHAS?",
      "My filling from last month fell out and it’s hurting. Not happy about this.",
    ],
    preview: "Can I shift my appointment to Friday?",
  },
} as const;
export function defaultHandovers(): Handovers {
  return {
    presets: Object.fromEntries(
      handoverPresets.map((p) => [
        p.key,
        {
          enabled: p.enabled,
          ...(p.key === "large_group"
            ? { params: { min_group_size: 10 } }
            : {}),
        },
      ]),
    ),
    custom: [],
  };
}
export function voiceInstruction(voice: Voice) {
  return voice.mode === "preset"
    ? voicePresets.find((p) => p.id === voice.preset_id)!.instruction
    : voice.custom_notes.map((note) => `- ${note}`).join("\n");
}
export function previewReplies(id: PresetId) {
  const first = {
    friendly:
      "Hi there! 😊 What date are you thinking? I can help you check the options.",
    formal:
      "Good evening. For which date would you like to enquire about a table for four at 8:00pm?",
    warm: "Hello! We’d love to help. What date did you have in mind for four around 8?",
    small: "hey! 4 pax around 8 — what date?",
    playful: "Dinner plans! 🎉 Four around 8 — what date are we thinking?",
    reassuring:
      "Hi, happy to help. What date would you like to enquire about for four at 8pm?",
  };
  const second = {
    friendly:
      "Happy birthday to your mum! 🎂 Our team will confirm the cake policy for you.",
    formal: "Our team will confirm whether an outside cake is permitted.",
    warm: "That sounds lovely. Our team will confirm the cake policy for your celebration.",
    small: "happy birthday to your mum! our team will confirm the cake policy",
    playful:
      "Birthday plans! 🎂 Our team will confirm the cake policy before you bring it along.",
    reassuring: "Our team will confirm the cake policy so you can plan ahead.",
  };
  return [first[id], second[id]];
}
