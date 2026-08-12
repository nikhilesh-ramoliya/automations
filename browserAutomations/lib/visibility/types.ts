/** Visibility / personal-profile marketing data under `data/visibility/<runId>/`. */

export type VisibilityRunConfigSnapshot = {
  maxPosts: number;
  maxReactions: number;
  maxComments: number;
  maxDrafts: number;
  maxProfiles?: number;
  maxConnects?: number;
  keywords: string[];
  icpQueries?: string[];
  likeMinScore: number;
  commentMinScore: number;
  dryRun: boolean;
  mode?: "keyword_posts" | "targeted_people";
};

export type VisibilityRunMeta = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  purpose: "visibility";
  config: VisibilityRunConfigSnapshot;
  stepsCompleted: string[];
};

export type FoundPost = {
  id: string;
  url?: string;
  authorName?: string;
  authorHeadline?: string;
  /** Author /in/ URL when scraped from the card */
  authorProfileUrl?: string;
  text: string;
  keyword: string;
  discoveredAt: string;
  /** Relative time shown on card, if any */
  relativeTime?: string;
};

export type TargetPerson = {
  id: string;
  name: string;
  title?: string;
  profileUrl: string;
  location?: string;
  query: string;
  discoveredAt: string;
  profileViewed?: boolean;
  connected?: boolean;
  connectMode?: string;
  notes?: string[];
};

export type EngagementRecord = {
  postId: string;
  postUrl?: string;
  targetPersonId?: string;
  targetName?: string;
  reacted: boolean;
  reactionAt?: string;
  commentDrafted: boolean;
  commentText?: string;
  commentSent: boolean;
  commentAt?: string;
  /** Connection attempted because post matched software-dev lead criteria */
  connectAttempted?: boolean;
  connectMode?: string;
  leadFitScore?: number;
  dryRun: boolean;
  relevanceScore?: number;
  relevanceReasons?: string[];
  notes?: string[];
};

export type PostDraft = {
  id: string;
  topic: string;
  body: string;
  hashtags: string[];
  inspiredByPostIds: string[];
  draftedAt: string;
};

export const VISIBILITY_ARTIFACTS = {
  meta: "meta.json",
  posts: "posts.json",
  engagements: "engagements.json",
  drafts: "drafts.json",
  targets: "targets.json",
} as const;
