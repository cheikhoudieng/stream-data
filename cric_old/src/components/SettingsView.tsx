import React, { useState } from 'react';
import { UploadCloud, Link as LinkIcon, DownloadCloud } from 'lucide-react';

interface SettingsViewProps {
  onFileUpload: (file: File) => void;
  onFetchApi: (url: string) => void;
  apiUrl: string;
  isLoading: boolean;
}

export function SettingsView({ onFileUpload, onFetchApi, apiUrl, isLoading }: SettingsViewProps) {
  const [urlInput, setUrlInput] = useState(apiUrl|| "https://raw.githubusercontent.com/cheikhoudieng/stream-data/refs/heads/main/live/output/events.json");

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileUpload(e.target.files[0]);
    }
  };

  const handleFetch = (e: React.FormEvent) => {
    e.preventDefault();
    if (urlInput.trim()) {
      onFetchApi(urlInput.trim());
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-4 sm:p-8 space-y-8 max-w-2xl mx-auto w-full">
      <div className="w-full text-center mb-4">
        <h2 className="text-2xl font-bold text-slate-200 mb-2">Configuration de la Source</h2>
        <p className="text-slate-400 text-sm">Importez un fichier JSON local ou connectez une API distante</p>
      </div>

      {/* API Config */}
      <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 relative">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-lg">
            <LinkIcon className="w-5 h-5" />
          </div>
          <h3 className="font-bold text-slate-200">Backend API</h3>
        </div>
        
        <form onSubmit={handleFetch} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">URL de l'API (ex: https://mon-domaine.com/events.json)</label>
            <input 
              type="url" 
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://..." 
              required
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus-visible:ring-1 focus-visible:ring-indigo-500 font-mono transition-colors"
            />
          </div>
          <button 
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                Chargement...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <DownloadCloud className="w-4 h-4" />
                Connecter & Récupérer
              </span>
            )}
          </button>
        </form>
      </div>

      <div className="w-full flex items-center gap-4 text-slate-500 text-sm font-medium">
        <div className="h-px bg-slate-800 flex-1" />
        OU
        <div className="h-px bg-slate-800 flex-1" />
      </div>

      {/* File Upload */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        className="flex flex-col items-center justify-center w-full h-48 border border-dashed rounded-2xl cursor-pointer bg-slate-900 border-slate-700 hover:border-indigo-500 hover:bg-slate-800/80 transition-all relative focus-within:ring-2 focus-within:ring-indigo-500"
      >
        <div className="flex flex-col items-center justify-center text-center px-4">
          <UploadCloud className="w-10 h-10 mb-3 text-slate-500" />
          <p className="mb-1 text-sm text-slate-400">
            <span className="font-semibold text-indigo-400">Cliquez pour importer</span> ou glissez un fichier
          </p>
          <p className="text-xs text-slate-500">JSON (.json)</p>
        </div>
        <input
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileChange}
          id="file-upload"
        />
        <label 
          htmlFor="file-upload" 
          className="absolute inset-0 cursor-pointer w-full h-full rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500" 
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              document.getElementById('file-upload')?.click();
            }
          }}
        />
      </div>
    </div>
  );
}
