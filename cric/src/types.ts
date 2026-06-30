export interface EventItem {
  id: number;
  event: EventDetailsData;
  links: EventLink[];
  order_index: number;
}

export interface EventDetailsData {
  eventDetails: {
    category: string;
    eventName: string;
    eventLogo: string;
  };
  teamA?: { name: string; logo: string };
  teamB?: { name: string; logo: string };
  visible: boolean;
  priority?: number;
  date: string;
  time: string;
  link_names: string[];
}

export interface EventLink {
  name: string;
  link: string;
  scheme?: number;
  api?: string;
  tokenApi?: string;
}

export interface CategoryItem {
  id: number;
  cat: CategoryDetails;
  table_name: string;
  order_index: number;
}

export interface CategoryDetails {
  visible: boolean;
  name: string;
  logo: string;
  type: string;
  api: string;
}
