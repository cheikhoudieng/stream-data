import React, { useState } from 'react';
import { CategoryItem } from '../types';
import { Layers, X, Copy, Check, Play } from 'lucide-react';
import QRCode from 'react-qr-code';
import { StreamSource } from './PlayerView';

interface CategoriesViewProps {
  categories: CategoryItem[];
  onPlayStream: (streams: StreamSource[]) => void;
}

export function CategoriesView({ categories, onPlayStream }: CategoriesViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<CategoryItem | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSelect = (item: CategoryItem) => {
    if ((!item.channels || item.channels.length === 0) && item.cat.api) {
      // Direct play if it's an API link with no sub-channels
      let type = 'auto';
      if (item.cat.api.includes('.m3u8')) type = 'hls';
      else if (item.cat.api.includes('.mpd')) type = 'dash';
      
      onPlayStream([{
        name: item.cat.name,
        url: item.cat.api,
        type,
        drmType: 'none',
        clearkeys: '',
        licenseUrl: ''
      }]);
      return;
    }

    setSelectedCategory(item);
    setCopied(false);
  };

  const handleCopy = () => {
    if (selectedCategory?.cat.api) {
      navigator.clipboard.writeText(selectedCategory.cat.api).catch(console.error);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const closeModal = () => setSelectedCategory(null);

  const handlePlayChannel = (linkObj: any) => {
    let type = 'auto';
    if (linkObj.link.includes('.m3u8')) type = 'hls';
    else if (linkObj.link.includes('.mpd')) type = 'dash';
    
    let drmType = 'none';
    let clearkeys = '';
    let licenseUrl = '';
    
    if (linkObj.api) {
      drmType = 'clearkey';
      if (linkObj.api.startsWith('http')) {
        licenseUrl = linkObj.api;
      } else {
        clearkeys = linkObj.api;
      }
    }

    onPlayStream([{
      name: linkObj.name,
      url: linkObj.link,
      type,
      drmType,
      clearkeys,
      licenseUrl
    }]);
    closeModal();
  };

  if (categories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-500">
        <Layers className="w-12 h-12 mb-4 opacity-50" />
        <p>Aucune catégorie chargée.</p>
      </div>
    );
  }

  const sorted = [...categories].sort((a, b) => a.order_index - b.order_index);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {sorted.map((item) => (
          <CategoryCard key={item.id} item={item} onClick={() => handleSelect(item)} />
        ))}
      </div>

      {selectedCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col my-auto">
            <div className="w-full flex items-center justify-between mb-6">
              <h3 className="font-bold text-lg text-slate-200">{selectedCategory.cat.name}</h3>
              <button onClick={closeModal} className="text-slate-500 hover:text-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {selectedCategory.channels && selectedCategory.channels.length > 0 ? (
              <div className="w-full max-h-96 overflow-y-auto custom-scrollbar pr-2 space-y-2 mb-4">
                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">Chaînes ({selectedCategory.channels.length})</h4>
                {selectedCategory.channels.map((ch, idx) => (
                   <button
                     key={idx}
                     onClick={() => handlePlayChannel(ch)}
                     className="w-full flex items-center p-3 bg-slate-950 border border-slate-800 rounded-xl hover:border-indigo-500 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                   >
                     {/* @ts-ignore */}
                     {ch.logo && (
                       <img src={(ch as any).logo} alt={ch.name} className="w-8 h-8 object-contain mr-3 rounded" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                     )}
                     <span className="flex-1 text-left text-sm font-medium text-slate-300 group-hover:text-indigo-400 truncate">{ch.name}</span>
                     <Play className="w-4 h-4 text-slate-600 group-hover:text-indigo-400 shrink-0 ml-2" />
                   </button>
                ))}
              </div>
            ) : (
              selectedCategory.cat.api && (
                <>
                  <div className="bg-white p-4 rounded-xl mb-6 mx-auto">
                    <QRCode 
                      value={selectedCategory.cat.api} 
                      size={200}
                      style={{ height: "auto", maxWidth: "100%", width: "100%" }}
                    />
                  </div>
                  <div className="w-full space-y-2">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">M3U Link (API)</label>
                    <div className="flex items-center space-x-2">
                      <div className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono overflow-hidden whitespace-nowrap text-ellipsis">
                        {selectedCategory.cat.api}
                      </div>
                      <button 
                        onClick={handleCopy}
                        className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex-shrink-0"
                        title="Copy to clipboard"
                      >
                        {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                </>
              )
            )}
            
            {(!selectedCategory.channels || selectedCategory.channels.length === 0) && !selectedCategory.cat.api && (
              <p className="text-sm text-slate-500 text-center italic">Aucune chaîne ou API configurée pour cette catégorie.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const CategoryCard: React.FC<{ item: CategoryItem, onClick: () => void }> = ({ item, onClick }) => {
  const { name, logo, type } = item.cat;
  
  return (
    <div 
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center text-center hover:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-all cursor-pointer relative group"
    >
      {logo ? (
        <img 
          src={logo} 
          alt={name} 
          className="w-16 h-16 mb-3 object-contain" 
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : (
        <div className="w-16 h-16 mb-3 flex items-center justify-center bg-slate-800 rounded-xl text-slate-500 font-bold">
          {name.substring(0, 2)}
        </div>
      )}
      <h3 className="font-bold text-sm text-slate-200 line-clamp-2">{name}</h3>
      {item.channels && item.channels.length > 0 ? (
        <p className="text-[10px] text-indigo-400 mt-1 uppercase font-mono">{item.channels.length} Chaînes</p>
      ) : type ? (
        <p className="text-[10px] text-slate-500 mt-1 uppercase font-mono">{type}</p>
      ) : null}
    </div>
  );
}
