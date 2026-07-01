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

  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrl') || '');
  const [isLoading, setIsLoading] = useState(false);

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);
        
        if (Array.isArray(parsed)) {
          if (parsed.length > 0) {
            if ('event' in parsed[0]) {
              const validEvents = parsed.map(parseEvent).filter(Boolean) as EventItem[];
              setEvents((prev) => {
                const newIds = new Set(validEvents.map(v => v.id));
                const filteredPrev = prev.filter(p => !newIds.has(p.id));
                return [...filteredPrev, ...validEvents];
              });
              setActiveTab('events');
            } else if ('cat' in parsed[0]) {
              const validCats = parsed.map(parseCategory).filter(Boolean) as CategoryItem[];
              setCategories((prev) => {
                const newIds = new Set(validCats.map(v => v.id));
                const filteredPrev = prev.filter(p => !newIds.has(p.id));
                return [...filteredPrev, ...validCats];
              });
              setActiveTab('categories');
            }
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          setCategoryLogos((prev) => ({ ...prev, ...parsed }));
          console.log('Loaded object dictionary:', Object.keys(parsed).length, 'keys');
          setActiveTab('events');
        }
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
      
      if (Array.isArray(parsed)) {
          if (parsed.length > 0) {
            if ('event' in parsed[0]) {
              const validEvents = parsed.map(parseEvent).filter(Boolean) as EventItem[];
              setEvents(validEvents);
            } else if ('cat' in parsed[0]) {
              const validCats = parsed.map(parseCategory).filter(Boolean) as CategoryItem[];
              setCategories(validCats);
            }
          }
      } else if (typeof parsed === 'object' && parsed !== null) {
          if (parsed.events) {
             const validEvents = parsed.events.map(parseEvent).filter(Boolean) as EventItem[];
             setEvents(validEvents);
          }
          if (parsed.categories) {
             const validCats = parsed.categories.map(parseCategory).filter(Boolean) as CategoryItem[];
             setCategories(validCats);
          }
          if (parsed.category_logos) {
              setCategoryLogos(parsed.category_logos);
          }
      }
      localStorage.setItem('apiUrl', url);
      setApiUrl(url);
      setActiveTab('events');
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
      <header className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-xl text-white">
            C2
          </div>
          <div>
            <h1 className="text-lg font-bold leading-none text-white">Cricfy2 Viewer</h1>
            <p className="text-xs text-slate-400">Ultimate Edition</p>
          </div>
        </div>

        <nav className="flex space-x-1 sm:space-x-4">
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
              className="p-2 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              title="Actualiser les données de l'API"
            >
              <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={clearData}
            className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors border border-transparent hover:border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            title="Effacer les données"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 h-full ${activeTab === 'player' ? 'max-w-full' : ''}`}>
          {activeTab === 'settings' && <SettingsView onFileUpload={handleFileUpload} onFetchApi={fetchFromApi} apiUrl={apiUrl} isLoading={isLoading} />}
          {activeTab === 'events' && <EventsView events={events} onPlayStream={handlePlayStream} categoryLogos={categoryLogos} />}
          {activeTab === 'categories' && <CategoriesView categories={categories} />}
          {activeTab === 'player' && <PlayerView initialStreams={streamsToPlay} events={events} onPlayStream={handlePlayStream} categoryLogos={categoryLogos} />}
        </div>
      </main>

      {/* Footer */}
      {(events.length > 0 || categories.length > 0) && (
        <footer className="h-12 bg-slate-900 border-t border-slate-800 flex items-center px-6 text-xs text-slate-500 font-mono shrink-0">
          <div className="flex-1 flex items-center">
            <span className="text-emerald-500">SUCCESS</span>
            <span className="mx-3">|</span>
            {events.length > 0 && <span>events.json ({events.length} items)</span>}
            {events.length > 0 && categories.length > 0 && <span className="mx-3">|</span>}
            {categories.length > 0 && <span>categories.json ({categories.length} items)</span>}
          </div>
          <div className="flex items-center">
            <span className="mr-2">Process: Ready</span>
            <div className="w-24 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 w-full"></div>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
        active 
          ? 'bg-indigo-600/10 border-indigo-500/30 text-indigo-100' 
          : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800 hover:border-slate-700'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
