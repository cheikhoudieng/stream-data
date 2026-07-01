import React, { useState } from 'react';
import { CategoryItem } from '../types';
import { Layers, X, Copy, Check } from 'lucide-react';
import QRCode from 'react-qr-code';

interface CategoriesViewProps {
  categories: CategoryItem[];
}

export function CategoriesView({ categories }: CategoriesViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<CategoryItem | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSelect = (item: CategoryItem) => {
    setSelectedCategory(item);
    setCopied(false);
    if (item.cat.api) {
      navigator.clipboard.writeText(item.cat.api).catch(console.error);
    }
  };

  const handleCopy = () => {
    if (selectedCategory?.cat.api) {
      navigator.clipboard.writeText(selectedCategory.cat.api).catch(console.error);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const closeModal = () => setSelectedCategory(null);

  if (categories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-500">
        <Layers className="w-12 h-12 mb-4 opacity-50" />
        <p>No categories loaded yet.</p>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col items-center">
            <div className="w-full flex items-center justify-between mb-6">
              <h3 className="font-bold text-lg text-slate-200">{selectedCategory.cat.name}</h3>
              <button onClick={closeModal} className="text-slate-500 hover:text-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="bg-white p-4 rounded-xl mb-6">
              <QRCode 
                value={selectedCategory.cat.api || 'No API URL'} 
                size={200}
                style={{ height: "auto", maxWidth: "100%", width: "100%" }}
              />
            </div>
            
            <div className="w-full space-y-2">
              <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">M3U Link (API)</label>
              <div className="flex items-center space-x-2">
                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono overflow-hidden whitespace-nowrap text-ellipsis">
                  {selectedCategory.cat.api || 'No API URL'}
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
      {type && (
        <p className="text-[10px] text-slate-500 mt-1 uppercase font-mono">{type}</p>
      )}
    </div>
  );
}
