import React, { useState, useMemo } from 'react';
import { EventItem } from '../types';
import { Calendar, Clock, Play, Tv, Search, ArrowDownAZ, ListOrdered } from 'lucide-react';

import { StreamSource } from './PlayerView';

interface EventsViewProps {
  events: EventItem[];
  onPlayStream: (streams: StreamSource[]) => void;
  categoryLogos: Record<string, string>;
}

export function EventsView({ events, onPlayStream, categoryLogos }: EventsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'index' | 'name'>('index');

  const filteredAndGroupedEvents = useMemo(() => {
    // 1. Filter
    const query = searchQuery.toLowerCase();
    let filtered = events;
    
    if (query) {
      filtered = events.filter(e => {
        const { eventDetails, teamA, teamB } = e.event;
        return (
          (eventDetails.eventName && eventDetails.eventName.toLowerCase().includes(query)) ||
          (eventDetails.category && eventDetails.category.toLowerCase().includes(query)) ||
          (teamA?.name && teamA.name.toLowerCase().includes(query)) ||
          (teamB?.name && teamB.name.toLowerCase().includes(query))
        );
      });
    }

    // 2. Sort
    filtered = [...filtered].sort((a, b) => {
      if (sortBy === 'index') {
        return (a.order_index || 0) - (b.order_index || 0);
      } else {
        const nameA = a.event.eventDetails.eventName || '';
        const nameB = b.event.eventDetails.eventName || '';
        return nameA.localeCompare(nameB);
      }
    });

    // 3. Group
    const groups: Record<string, EventItem[]> = {};
    filtered.forEach(e => {
      const cat = e.event.eventDetails.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(e);
    });

    return groups;
  }, [events, searchQuery, sortBy]);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-500">
        <Tv className="w-12 h-12 mb-4 opacity-50" />
        <p>No events loaded yet.</p>
      </div>
    );
  }

  const categoryNames = Object.keys(filteredAndGroupedEvents).sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col space-y-6 pb-12">
      {/* Toolbar: Search and Sort */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="relative w-full sm:w-96">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="w-5 h-5 text-slate-500" />
          </div>
          <input
            type="text"
            placeholder="Rechercher (équipe, ligue, etc.)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus-visible:ring-1 focus-visible:ring-indigo-500 transition-colors"
          />
        </div>
        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <span className="text-sm text-slate-400 font-medium">Trier par:</span>
          <div className="flex bg-slate-950 rounded-lg border border-slate-700 p-1">
            <button
              onClick={() => setSortBy('index')}
              className={`flex items-center space-x-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                sortBy === 'index' ? 'bg-indigo-600/20 text-indigo-400' : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <ListOrdered className="w-4 h-4" />
              <span>Défaut</span>
            </button>
            <button
              onClick={() => setSortBy('name')}
              className={`flex items-center space-x-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                sortBy === 'name' ? 'bg-indigo-600/20 text-indigo-400' : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <ArrowDownAZ className="w-4 h-4" />
              <span>Nom</span>
            </button>
          </div>
        </div>
      </div>

      {/* Grouped Events */}
      {categoryNames.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-500">
          <Search className="w-12 h-12 mb-4 opacity-50" />
          <p>Aucun événement ne correspond à "{searchQuery}".</p>
        </div>
      ) : (
        categoryNames.map(category => (
          <div key={category} className="space-y-4">
            <div className="flex items-center space-x-3 pb-2 border-b border-slate-800">
              {categoryLogos[category] && (
                <img 
                  src={categoryLogos[category]} 
                  alt={category} 
                  className="w-6 h-6 object-contain rounded" 
                  referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <h2 className="text-lg font-bold text-slate-200 tracking-wide">{category}</h2>
              <span className="text-xs font-mono bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
                {filteredAndGroupedEvents[category].length}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {filteredAndGroupedEvents[category].map((item) => (
                <EventCard key={item.id} item={item} onPlayStream={onPlayStream} categoryLogos={categoryLogos} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const EventCard: React.FC<{ item: EventItem, onPlayStream: (streams: StreamSource[]) => void, categoryLogos: Record<string, string> }> = ({ item, onPlayStream, categoryLogos }) => {
  const { eventDetails, teamA, teamB, date, time } = item.event;
  const links = item.links;
  
  const displayLogo = eventDetails.eventLogo || categoryLogos[eventDetails.category];

  return (
    <div className="flex flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-indigo-500 transition-all">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-slate-900/50 border-b border-slate-800">
        <div className="flex items-center space-x-3">
          {displayLogo && (
            <img 
              src={displayLogo} 
              alt={eventDetails.category} 
              className="w-8 h-8 object-contain rounded-md" 
              referrerPolicy="no-referrer"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          <div>
            <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest">{eventDetails.category}</p>
            <p className="text-sm font-medium text-slate-200 line-clamp-1">{eventDetails.eventName}</p>
          </div>
        </div>
      </div>

      {/* Teams / Main Info */}
      <div className="p-6 flex-1 flex flex-col items-center justify-center min-h-[120px] bg-slate-900">
        {teamA && teamB && teamA.name && teamB.name ? (
          <div className="flex items-center justify-between w-full">
            <div className="flex flex-col items-center flex-1 text-center">
              {teamA.logo ? (
                <img 
                  src={teamA.logo} 
                  alt={teamA.name} 
                  className="w-12 h-12 object-contain mb-2" 
                  referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <div className="w-12 h-12 bg-slate-800 rounded-full mb-2 flex items-center justify-center font-bold text-slate-500">{teamA.name.substring(0, 2)}</div>
              )}
              <span className="font-bold text-sm text-slate-200">{teamA.name}</span>
            </div>
            <div className="px-4 font-black text-slate-600 text-lg italic">VS</div>
            <div className="flex flex-col items-center flex-1 text-center">
              {teamB.logo ? (
                <img 
                  src={teamB.logo} 
                  alt={teamB.name} 
                  className="w-12 h-12 object-contain mb-2" 
                  referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <div className="w-12 h-12 bg-slate-800 rounded-full mb-2 flex items-center justify-center font-bold text-slate-500">{teamB.name.substring(0, 2)}</div>
              )}
              <span className="font-bold text-sm text-slate-200">{teamB.name}</span>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-lg font-bold text-slate-200">{eventDetails.eventName}</p>
          </div>
        )}
      </div>

      {/* Footer / Meta */}
      <div className="px-4 py-4 bg-slate-900/80 border-t border-slate-800 flex flex-col space-y-4">
        <div className="flex items-center justify-between text-xs font-mono text-slate-400">
          <div className="flex items-center bg-slate-800 px-2 py-1 rounded">
            <Calendar className="w-3 h-3 mr-1 text-indigo-400" />
            {date}
          </div>
          <div className="flex items-center bg-slate-800 px-2 py-1 rounded">
            <Clock className="w-3 h-3 mr-1 text-indigo-400" />
            {time}
          </div>
        </div>

        {/* Links Action */}
        {links && links.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => {
                const streams: StreamSource[] = links.map((link, idx) => {
                  let type = 'auto';
                  if (link.link.includes('.m3u8')) type = 'hls';
                  else if (link.link.includes('.mpd')) type = 'dash';
                  
                  let drmType = 'none';
                  let clearkeys = '';
                  let licenseUrl = '';
                  if (link.api) {
                    drmType = 'clearkey';
                    if (link.api.startsWith('http')) {
                      licenseUrl = link.api;
                    } else {
                      clearkeys = link.api;
                    }
                  }
                  return {
                    name: link.name || `${eventDetails.eventName} - Server ${idx + 1}`,
                    url: link.link,
                    type,
                    drmType,
                    clearkeys,
                    licenseUrl
                  };
                });
                onPlayStream(streams);
              }}
              className="w-full flex items-center justify-center py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            >
              <Play className="w-4 h-4 mr-2 fill-current" />
              Watch Match ({links.length} {links.length === 1 ? 'Server' : 'Servers'})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
