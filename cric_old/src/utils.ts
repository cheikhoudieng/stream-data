import { CategoryItem, EventItem } from './types';

export const parseEvent = (raw: any): EventItem | null => {
  try {
    const event = typeof raw.event === 'string' ? JSON.parse(raw.event) : raw.event;
    const links = typeof raw.links === 'string' ? JSON.parse(raw.links) : raw.links;
    return { ...raw, event, links };
  } catch (e) {
    console.error('Failed to parse event', e, raw);
    return null;
  }
};

export const parseCategory = (raw: any): CategoryItem | null => {
  try {
    const cat = typeof raw.cat === 'string' ? JSON.parse(raw.cat) : raw.cat;
    return { ...raw, cat };
  } catch (e) {
    console.error('Failed to parse category', e, raw);
    return null;
  }
};
