export const DEFAULT_STAGE_ID = 'junior';

export type ClassificationSource = 'ai' | 'manual';
export type ClassificationStatus = 'pending' | 'classified' | 'needs_confirmation' | 'failed';

export interface CatalogTopic {
  id: string;
  standardKey: string | null;
  name: string;
  aliases: string[];
}

export interface CatalogSubject {
  id: string;
  standardKey: string | null;
  name: string;
  topics: CatalogTopic[];
}

export interface ClassificationCatalog {
  stage: { id: string; name: string };
  version: number;
  subjects: CatalogSubject[];
}
