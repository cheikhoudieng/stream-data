import { CategoryItem, EventItem } from './types';

export const parseEvent = (raw: any): EventItem | null => {
  try {
    // Handle old format
    if (raw.event && typeof raw.event === 'string') {
      const event = JSON.parse(raw.event);
      const links = typeof raw.links === 'string' ? JSON.parse(raw.links) : raw.links;
      return { ...raw, event, links };
    }
    if (raw.event && typeof raw.event === 'object') {
      return { ...raw };
    }
    // Handle new format
    if (raw.event_name || raw.category) {
      return {
        id: raw.id,
        order_index: raw.order_index,
        event: {
          eventDetails: {
            category: raw.category,
            eventName: raw.event_name,
            eventLogo: raw.event_logo
          },
          teamA: raw.team_a,
          teamB: raw.team_b,
          date: raw.date,
          time: raw.time,
          visible: true,
          link_names: []
        },
        links: raw.streams || []
      };
    }
    return null;
  } catch (e) {
    console.error('Failed to parse event', e, raw);
    return null;
  }
};

export const parseCategory = (raw: any): CategoryItem | null => {
  try {
    // Handle old format
    if (raw.cat && typeof raw.cat === 'string') {
      const cat = JSON.parse(raw.cat);
      return { ...raw, cat };
    }
    if (raw.cat && typeof raw.cat === 'object') {
      return { ...raw };
    }
    // Handle new format
    if (raw.name || raw.type) {
      return {
        id: raw.id,
        order_index: raw.order_index,
        cat: {
          name: raw.name,
          logo: raw.logo,
          type: raw.type,
          api: raw.playlist_url || '',
          visible: true
        },
        channels: raw.channels
      };
    }
    return null;
  } catch (e) {
    console.error('Failed to parse category', e, raw);
    return null;
  }
};

