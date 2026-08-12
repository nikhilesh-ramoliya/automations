/** LinkedIn content engine artifacts under `data/content/<runId>/`. */

export type ContentDraftStatus = "draft" | "reviewed" | "published";

export type PostAngle =
  | "educational"
  | "founder_insight"
  | "opinion"
  | "technical_lesson"
  | "storytelling";

export type ContentCategory =
  | "AI"
  | "Software Engineering"
  | "Startups"
  | "SaaS"
  | "Automation"
  | "Playwright"
  | "Testing"
  | "Cloud"
  | "DevOps"
  | "Product Development"
  | "Engineering Leadership"
  | "Scaling Teams"
  | "MVP Development"
  | "Case Studies"
  | "Performance"
  | "Architecture";

export type ContentRunConfigSnapshot = {
  maxTopics: number;
  maxVariations: number;
  minScore: number;
  categories: string[];
  audiences: string[];
  dryRun: boolean;
  aiEnabled: boolean;
};

export type ContentRunMeta = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  purpose: "content";
  config: ContentRunConfigSnapshot;
  stepsCompleted: string[];
};

export type ContentTopic = {
  id: string;
  title: string;
  summary: string;
  category: string;
  targetAudience: string;
  reason: string;
  suggestedAngle: PostAngle | string;
  /** Interest theme from instructions.md this topic serves */
  interest?: string;
  researchedAt: string;
  source: "ai" | "template";
};

export type ContentScoreBreakdown = {
  originality: number;
  readability: number;
  engagementPotential: number;
  technicalAccuracy: number;
  relevance: number;
  brandAlignment: number;
  /** Weighted 0–100 total. */
  total: number;
};

export type ContentDraft = {
  id: string;
  topicId: string;
  topic: string;
  category: string;
  audience: string;
  angle: PostAngle | string;
  /** Interest theme this draft serves (from topic / instructions) */
  interest?: string;
  content: string;
  hashtags: string[];
  score: number;
  scoreBreakdown: ContentScoreBreakdown;
  status: ContentDraftStatus;
  generatedAt: string;
  source: "ai" | "template";
  /** True when content was adjusted to satisfy instructions.md */
  refined?: boolean;
  /** Remaining or noted instruction issues after validate/refine */
  instructionIssues?: string[];
};

export const CONTENT_ARTIFACTS = {
  meta: "meta.json",
  topics: "topics.json",
  drafts: "drafts.json",
} as const;

export const DEFAULT_CONTENT_CATEGORIES: ContentCategory[] = [
  "AI",
  "Software Engineering",
  "Startups",
  "SaaS",
  "Automation",
  "Playwright",
  "Testing",
  "Cloud",
  "DevOps",
  "Product Development",
  "Engineering Leadership",
  "Scaling Teams",
  "MVP Development",
  "Case Studies",
  "Performance",
  "Architecture",
];

export const DEFAULT_CONTENT_AUDIENCES = [
  "Startup founders",
  "CTOs",
  "Engineering Managers",
  "Product Leaders",
  "Companies looking to outsource software development",
  "Companies interested in AI automation",
];

export const POST_ANGLES: PostAngle[] = [
  "educational",
  "founder_insight",
  "opinion",
  "technical_lesson",
  "storytelling",
];
