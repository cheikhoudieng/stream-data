import React, { useState, useEffect } from 'react';
import { SettingsView } from './components/SettingsView';
import { EventsView } from './components/EventsView';
import { CategoriesView } from './components/CategoriesView';
import { PlayerView, StreamSource } from './components/PlayerView';
import { CategoryItem, EventItem } from './types';
import { parseCategory, parseEvent } from './utils';
import { Database, Tv, Layers, Trash2, MonitorPlay, RefreshCw, Settings } from 'lucide-react';

export default function App() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryLogos, setCategoryLogos] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'settings' | 'events' | 'categories' | 'player'>('settings');
  const [streamsToPlay, setStreamsToPlay] = useState<StreamSource[] | null>(null);

  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrlV2') || '');
  const [isLoading, setIsLoading] = useState(false);

  const processData = (parsed: any) => {
    let validEvents: EventItem[] = [];
    let validCats: CategoryItem[] = [];
    let logos: Record<string, string> = {};

    if (Array.isArray(parsed)) {
      if (parsed.length > 0) {
        if ('event' in parsed[0]) {
          validEvents = parsed.map(parseEvent).filter(Boolean) as EventItem[];
        } else if ('cat' in parsed[0]) {
          validCats = parsed.map(parseCategory).filter(Boolean) as CategoryItem[];
        }
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.sports_events || parsed.live_tv || parsed.sports_tournaments) {
        if (parsed.sports_events) {
          validEvents = parsed.sports_events.map(parseEvent).filter(Boolean) as EventItem[];
        }
        if (parsed.live_tv) {
          validCats = parsed.live_tv.map(parseCategory).filter(Boolean) as CategoryItem[];
        }
        if (parsed.sports_tournaments) {
          logos = parsed.sports_tournaments;
        }
      } else {
        if (parsed.events) {
          validEvents = parsed.events.map(parseEvent).filter(Boolean) as EventItem[];
        }
        if (parsed.categories) {
          validCats = parsed.categories.map(parseCategory).filter(Boolean) as CategoryItem[];
        }
        if (parsed.category_logos) {
          logos = parsed.category_logos;
        } else {
          logos = parsed; // Fallback for old simple dict
        }
      }
    }

    if (validEvents.length > 0) setEvents(prev => {
      const newIds = new Set(validEvents.map(v => v.id));
      const filteredPrev = prev.filter(p => !newIds.has(p.id));
      return [...filteredPrev, ...validEvents];
    });
    
    if (validCats.length > 0) {
      validCats = validCats.filter(cat => {
        const hasChannels = cat.channels && cat.channels.length > 0;
        const hasApi = !!cat.cat.api;
        if (cat.cat.type === 'custom' && !hasChannels) return false;
        if (cat.cat.type === 'm3u' && !hasApi && !hasChannels) return false;
        if (!hasChannels && !hasApi) return false; // Default fallback
        return true;
      });
      setCategories(prev => {
        const newIds = new Set(validCats.map(v => v.id));
        const filteredPrev = prev.filter(p => !newIds.has(p.id));
        return [...filteredPrev, ...validCats];
      });
    }

    if (Object.keys(logos).length > 0) {
      setCategoryLogos(prev => ({ ...prev, ...logos }));
    }

    if (validEvents.length > 0) {
      setActiveTab('events');
    } else if (validCats.length > 0) {
      setActiveTab('categories');
    }
  };

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);
        processData(parsed);
      } catch (err) {
        console.error('Invalid JSON file', err);
        alert(`Failed to parse ${file.name}. Please ensure it's a valid JSON file.`);
      }
    };
    reader.readAsText(file);
  };

  const fetchFromApi = async (url: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Network response was not ok');
      const text = await response.text();
      const parsed = JSON.parse(text);
      processData(parsed);
      
      localStorage.setItem('apiUrl', url);
      setApiUrl(url);
    } catch (err) {
      console.error('Failed to fetch API', err);
      alert('Failed to fetch from API: ' + (err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const clearData = () => {
    setEvents([]);
    setCategories([]);
    setCategoryLogos({});
    setStreamsToPlay(null);
    localStorage.removeItem('apiUrl');
    setApiUrl('');
    setActiveTab('settings');
  };

  const handlePlayStream = (streams: StreamSource[]) => {
    setStreamsToPlay(streams);
    setActiveTab('player');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans flex flex-col selection:bg-indigo-500/30">
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 bg-slate-900 border-b border-slate-800 shrink-0 sticky top-0 z-40">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-indigo-500/20">
            C2
          </div>
          <div>
            <h1 className="text-base font-bold leading-none text-white tracking-tight">Cricfy2 Viewer</h1>
            <p className="text-[10px] text-slate-400 uppercase font-mono tracking-wider mt-1">Ultimate Edition</p>
          </div>
        </div>

        {/* Desktop Navigation */}
        <nav className="hidden sm:flex space-x-2 absolute left-1/2 -translate-x-1/2">
          <TabButton 
            active={activeTab === 'settings'} 
            onClick={() => setActiveTab('settings')} 
            icon={<Settings className="w-4 h-4" />} 
            label="Paramètres" 
          />
          <TabButton 
            active={activeTab === 'events'} 
            onClick={() => setActiveTab('events')} 
            icon={<Tv className="w-4 h-4" />} 
            label={`Events ${events.length > 0 ? `(${events.length})` : ''}`} 
          />
          <TabButton 
            active={activeTab === 'categories'} 
            onClick={() => setActiveTab('categories')} 
            icon={<Layers className="w-4 h-4" />} 
            label={`Categories ${categories.length > 0 ? `(${categories.length})` : ''}`} 
          />
          <TabButton 
            active={activeTab === 'player'} 
            onClick={() => setActiveTab('player')} 
            icon={<MonitorPlay className="w-4 h-4" />} 
            label="Player" 
          />
        </nav>

        <div className="flex items-center space-x-2">
          {apiUrl && (
            <button
              onClick={() => fetchFromApi(apiUrl)}
              disabled={isLoading}
              className="p-2 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-lg transition-colors border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              title="Actualiser les données de l'API"
            >
              <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={clearData}
            className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            title="Effacer les données"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pb-20 sm:pb-0 scroll-smooth">
        <div className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 h-full ${activeTab === 'player' ? 'max-w-full !p-0' : ''}`}>
          {activeTab === 'settings' && <SettingsView onFileUpload={handleFileUpload} onFetchApi={fetchFromApi} apiUrl={apiUrl} isLoading={isLoading} />}
          {activeTab === 'events' && <EventsView events={events} onPlayStream={handlePlayStream} categoryLogos={categoryLogos} />}
          {activeTab === 'categories' && <CategoriesView categories={categories} onPlayStream={handlePlayStream} />}
          {activeTab === 'player' && <PlayerView initialStreams={streamsToPlay} events={events} onPlayStream={handlePlayStream} categoryLogos={categoryLogos} />}
        </div>
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-lg border-t border-slate-800 flex items-center justify-around px-2 py-2 z-50 safe-area-bottom">
        <MobileTabButton 
          active={activeTab === 'settings'} 
          onClick={() => setActiveTab('settings')} 
          icon={<Settings className="w-5 h-5" />} 
          label="Paramètres" 
        />
        <MobileTabButton 
          active={activeTab === 'events'} 
          onClick={() => setActiveTab('events')} 
          icon={<Tv className="w-5 h-5" />} 
          label="Events"
          badge={events.length > 0 ? events.length : undefined}
        />
        <MobileTabButton 
          active={activeTab === 'categories'} 
          onClick={() => setActiveTab('categories')} 
          icon={<Layers className="w-5 h-5" />} 
          label="Categories"
          badge={categories.length > 0 ? categories.length : undefined}
        />
        <MobileTabButton 
          active={activeTab === 'player'} 
          onClick={() => setActiveTab('player')} 
          icon={<MonitorPlay className="w-5 h-5" />} 
          label="Player" 
        />
      </nav>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
        active 
          ? 'bg-indigo-500/15 text-indigo-400' 
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MobileTabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all duration-200 focus-visible:outline-none ${
        active ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      <div className={`flex items-center justify-center w-8 h-8 rounded-full mb-1 transition-colors ${active ? 'bg-indigo-500/20' : 'bg-transparent'}`}>
        {icon}
      </div>
      <span className="text-[10px] font-medium leading-none">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0 right-2 w-4 h-4 bg-indigo-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center ring-2 ring-slate-900">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
