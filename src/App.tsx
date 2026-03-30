import React, { useState, useEffect, useCallback, useRef } from 'react';
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { 
  Waves, 
  RefreshCw, 
  Info, 
  AlertTriangle, 
  CheckCircle2, 
  Navigation,
  Droplets,
  Bell,
  Settings,
  Search,
  Plus,
  Trash2,
  X,
  BellRing,
  ExternalLink,
  Star,
  StarOff,
  History,
  MapPin,
  Loader2,
  Ruler,
  Edit2,
  StickyNote,
  LogOut,
  LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// USGS Site Constants
const PARAM_CFS = '00060'; // Discharge, cubic feet per second
const PARAM_FEET = '00065'; // Gage height, feet

interface Alert {
  id: string;
  parameter: 'cfs' | 'feet';
  condition: 'above' | 'below';
  value: string;
  enabled: boolean;
}

interface Favorite {
  id: string;
  name: string;
  customName?: string;
  notes?: string;
}

interface RiverData {
  cfs: number;
  feet: number;
  siteName: string;
  siteCode: string;
  lastUpdated: Date;
}

interface SearchResult {
  id: string;
  name: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Persistence
  const [siteId, setSiteId] = useState(() => localStorage.getItem('river-monitor-site') || localStorage.getItem('river-monitor-default-site') || '03161000');
  const [defaultSiteId, setDefaultSiteId] = useState(() => localStorage.getItem('river-monitor-default-site') || '');
  const [alerts, setAlerts] = useState<Alert[]>(() => {
    const saved = localStorage.getItem('river-monitor-alerts');
    return saved ? JSON.parse(saved) : [];
  });
  const [favorites, setFavorites] = useState<Favorite[]>(() => {
    const saved = localStorage.getItem('river-monitor-favorites');
    return saved ? JSON.parse(saved) : [];
  });

  const saveToFirestore = async (updates: any) => {
    if (!auth.currentUser) return;
    const path = `users/${auth.currentUser.uid}`;
    try {
      await setDoc(doc(db, path), { uid: auth.currentUser.uid, ...updates }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  };

  const handleSetFavorites = (newFavorites: Favorite[]) => {
    setFavorites(newFavorites);
    saveToFirestore({ favorites: newFavorites });
  };

  const handleSetAlerts = (newAlerts: Alert[]) => {
    setAlerts(newAlerts);
    saveToFirestore({ alerts: newAlerts });
  };

  const handleSetDefaultSiteId = (newId: string) => {
    setDefaultSiteId(newId);
    saveToFirestore({ defaultSiteId: newId || null });
  };

  const updateFavorite = (id: string, updates: Partial<Favorite>) => {
    handleSetFavorites(favorites.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;
    if (!user) return;

    const path = `users/${user.uid}`;
    const unsubscribe = onSnapshot(doc(db, path), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.defaultSiteId !== undefined) setDefaultSiteId(data.defaultSiteId || '');
        if (data.alerts !== undefined) setAlerts(data.alerts);
        if (data.favorites !== undefined) setFavorites(data.favorites);
      } else {
        // Initial sync: save local data to Firestore
        const localDefaultSiteId = localStorage.getItem('river-monitor-default-site') || '';
        const localAlerts = JSON.parse(localStorage.getItem('river-monitor-alerts') || '[]');
        const localFavorites = JSON.parse(localStorage.getItem('river-monitor-favorites') || '[]');
        saveToFirestore({
          defaultSiteId: localDefaultSiteId || null,
          alerts: localAlerts,
          favorites: localFavorites
        });
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const [data, setData] = useState<RiverData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [showFavoritesDropdown, setShowFavoritesDropdown] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [triggeredAlerts, setTriggeredAlerts] = useState<string[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'alerts' | 'favorites'>('alerts');
  const [nextCheckTime, setNextCheckTime] = useState<Date | null>(null);
  const [timeUntilCheck, setTimeUntilCheck] = useState<string>('');

  const lastNotificationRef = useRef<Record<string, number>>({});
  const searchRef = useRef<HTMLDivElement>(null);
  const favoritesRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Close search results and favorites dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
      if (favoritesRef.current && !favoritesRef.current.contains(event.target as Node)) {
        setShowFavoritesDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('river-monitor-site', siteId);
  }, [siteId]);

  useEffect(() => {
    localStorage.setItem('river-monitor-alerts', JSON.stringify(alerts));
  }, [alerts]);

  useEffect(() => {
    localStorage.setItem('river-monitor-favorites', JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (defaultSiteId) {
      localStorage.setItem('river-monitor-default-site', defaultSiteId);
    } else {
      localStorage.removeItem('river-monitor-default-site');
    }
  }, [defaultSiteId]);

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  const checkAlerts = useCallback((currentData: RiverData) => {
    const activeAlerts: string[] = [];
    const now = Date.now();

    alerts.forEach(alert => {
      if (!alert.enabled) return;

      const val = alert.parameter === 'cfs' ? currentData.cfs : currentData.feet;
      if (alert.value === '') return;
      
      const alertValue = Number(alert.value);
      if (isNaN(alertValue)) return;
      const triggered = alert.condition === 'above' ? val > alertValue : val < alertValue;

      if (triggered) {
        activeAlerts.push(alert.id);
        
        const lastNotified = lastNotificationRef.current[alert.id] || 0;
        if (now - lastNotified > 3600000 && Notification.permission === 'granted') {
          new Notification(`River Alert: ${currentData.siteName}`, {
            body: `${alert.parameter.toUpperCase()} is ${alert.condition} ${alert.value} (Current: ${val})`,
            icon: '/favicon.ico'
          });
          lastNotificationRef.current[alert.id] = now;
        }
      }
    });

    setTriggeredAlerts(prev => {
      if (prev.length === activeAlerts.length && prev.every((v, i) => v === activeAlerts[i])) {
        return prev;
      }
      return activeAlerts;
    });
    setDismissedAlerts(prev => {
      const next = prev.filter(id => activeAlerts.includes(id));
      if (prev.length === next.length && prev.every((v, i) => v === next[i])) {
        return prev;
      }
      return next;
    });
  }, [alerts]);

  useEffect(() => {
    if (data) {
      checkAlerts(data);
    }
  }, [data, checkAlerts]);

  const fetchRiverData = useCallback(async (targetSiteId: string = siteId) => {
    if (!targetSiteId) return;
    
    setIsRefreshing(true);
    setError(null);
    
    // Update siteId state immediately so the UI reflects the attempt
    if (targetSiteId !== siteId) {
      setSiteId(targetSiteId);
    }
    
    const startTime = Date.now();
    console.log(`[RiverMonitor] Fetching data for site: ${targetSiteId}`);
    
    try {
      // Try multiple strategies to get data
      const strategies = [
        { service: 'iv', params: `parameterCd=${PARAM_CFS},${PARAM_FEET}` },
        { service: 'iv', params: '' },
        { service: 'uv', params: '' }
      ];
      
      let timeSeries = null;

      for (const strategy of strategies) {
        try {
          // Add period=P1D to get data from the last 24 hours in case the most recent reading is delayed
          const url = `https://waterservices.usgs.gov/nwis/${strategy.service}/?format=json&sites=${targetSiteId}&siteStatus=all&period=P1D&${strategy.params}`;
          console.log(`[RiverMonitor] Strategy: ${strategy.service} ${strategy.params || '(all)'}`);
          
          const response = await fetch(url);
          if (!response.ok) continue;
          
          const json = await response.json();
          if (json.value?.timeSeries && json.value.timeSeries.length > 0) {
            timeSeries = json.value.timeSeries;
            console.log(`[RiverMonitor] Success with ${strategy.service}`);
            break;
          }
        } catch (e) {
          console.warn(`[RiverMonitor] Strategy failed:`, e);
        }
      }
      
      if (!timeSeries || timeSeries.length === 0) {
        // Final attempt: Check if the site even exists using the site service
        try {
          const siteUrl = `https://waterservices.usgs.gov/nwis/site/?format=json&sites=${targetSiteId}&siteStatus=all`;
          const siteRes = await fetch(siteUrl);
          if (siteRes.ok) {
            const siteJson = await siteRes.json();
            const siteInfo = siteJson.value?.site?.[0];
            if (siteInfo) {
              // We found the site but no data. Let's show the site name at least.
              setData({
                cfs: 0,
                feet: 0,
                siteName: siteInfo.siteName,
                siteCode: siteInfo.siteCode[0].value,
                lastUpdated: new Date()
              });
              throw new Error(`Station "${siteInfo.siteName}" found, but it has not reported any flow or depth data in the last 24 hours.`);
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('Station "')) throw e;
        }
        throw new Error('This station is not currently reporting real-time data to the USGS. It may be a historical-only site or temporarily offline.');
      }

      const siteName = timeSeries[0].sourceInfo.siteName;
      const siteCode = timeSeries[0].sourceInfo.siteCode[0].value;
      
      // Look for Discharge (00060) and Gage Height (00065)
      const cfsSeries = timeSeries.find((s: any) => s.variable.variableCode[0].value === PARAM_CFS);
      const feetSeries = timeSeries.find((s: any) => s.variable.variableCode[0].value === PARAM_FEET);

      // Get the most recent value from the series
      const getLatestValue = (series: any) => {
        if (!series?.values?.[0]?.value) return undefined;
        // Sort by dateTime descending to get the absolute latest
        const sorted = [...series.values[0].value].sort((a, b) => 
          new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime()
        );
        return sorted[0];
      };

      const cfsPoint = getLatestValue(cfsSeries);
      const feetPoint = getLatestValue(feetSeries);

      const cfsValue = cfsPoint?.value;
      const feetValue = feetPoint?.value;
      
      if (cfsValue === undefined && feetValue === undefined) {
        throw new Error(`Station "${siteName}" is active but does not currently report Water Flow (CFS) or Water Depth (FT).`);
      }

      // Try to get the most recent timestamp from either series
      const apiDateStr = cfsPoint?.dateTime || feetPoint?.dateTime;
      const lastUpdated = apiDateStr ? new Date(apiDateStr) : new Date();

      const newData: RiverData = {
        cfs: (cfsValue !== undefined && cfsValue !== "-999999") ? parseFloat(cfsValue) : 0,
        feet: (feetValue !== undefined && feetValue !== "-999999") ? parseFloat(feetValue) : 0,
        siteName: siteName,
        siteCode: siteCode,
        lastUpdated: lastUpdated,
      };

      setData(newData);
      setLastChecked(new Date());
      setError(null);
    } catch (err) {
      console.error('[RiverMonitor] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Error loading river data.');
    } finally {
      // Ensure at least 800ms of refresh animation for visual feedback
      const duration = Date.now() - startTime;
      if (duration < 800) {
        await new Promise(resolve => setTimeout(resolve, 800 - duration));
      }
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [siteId]);

  const searchStations = async () => {
    if (!searchInput.trim()) return;
    setIsSearching(true);
    setHasSearched(false);
    setShowResults(true);
    const query = searchInput.trim();
    const upperQuery = query.toUpperCase();
    console.log(`[RiverMonitor] Searching for: ${query}`);
    
    try {
      const results: SearchResult[] = [];
      const seen = new Set();

      const addResult = (id: string, name: string) => {
        if (id && name && !seen.has(id)) {
          results.push({ id, name });
          seen.add(id);
        }
      };

      const fetchAndParse = async (url: string) => {
        try {
          console.log(`[RiverMonitor] Fetching search results: ${url}`);
          const response = await fetch(url);
          if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[RiverMonitor] Search API error (${response.status}): ${errorText.substring(0, 100)}`);
            return;
          }
          
          let foundInThisFetch = 0;

          if (url.includes('format=rdb')) {
            const text = await response.text();
            const lines = text.split('\n');
            let headerParsed = false;
            let headers: string[] = [];
            
            for (const line of lines) {
              if (line.startsWith('#') || line.trim() === '') continue;
              
              const parts = line.split('\t');
              
              if (!headerParsed) {
                headers = parts.map(h => h.trim());
                headerParsed = true;
                continue;
              }
              
              // Skip the type definition line (e.g., 5s 15s)
              if (parts[0] && parts[0].endsWith('s') && parts[1] && parts[1].endsWith('s')) {
                continue;
              }
              
              const siteNoIndex = headers.indexOf('site_no');
              const stationNmIndex = headers.indexOf('station_nm');
              
              if (siteNoIndex !== -1 && stationNmIndex !== -1 && parts[siteNoIndex]) {
                addResult(parts[siteNoIndex].trim(), parts[stationNmIndex].trim());
                foundInThisFetch++;
              }
            }
          } else {
            const json = await response.json();
            
            // Parse Site Service structure (if any JSON site service queries remain)
            const sites = json.value?.site || json.site || json.value?.siteInfo || json.siteInfo || [];
            if (Array.isArray(sites)) {
              sites.forEach((s: any) => {
                const info = s.siteInfo || s;
                if (info.siteCode?.[0]) {
                  addResult(info.siteCode[0].value, info.siteName);
                  foundInThisFetch++;
                }
              });
            }

            // Parse IV/UV Service structure
            const timeSeries = json.value?.timeSeries || json.timeSeries || [];
            if (Array.isArray(timeSeries)) {
              timeSeries.forEach((ts: any) => {
                const s = ts.sourceInfo;
                if (s?.siteCode?.[0]) {
                  addResult(s.siteCode[0].value, s.siteName);
                  foundInThisFetch++;
                }
              });
            }
          }
          console.log(`[RiverMonitor] Found ${foundInThisFetch} sites in this fetch. Total unique: ${results.length}`);
        } catch (e) {
          console.warn(`[RiverMonitor] Failed to fetch or parse search results`, e);
        }
      };

      // Strategy 1: Site ID Search (7-15 digits)
      if (/^\d{7,15}$/.test(query)) {
        await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&sites=${query}&siteStatus=all`);
        if (results.length === 0) {
          await fetchAndParse(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${query}`);
        }
      } 
      
      // Strategy 2: Zip Code Search (5 digits)
      if (/^\d{5}$/.test(query)) {
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${query}&countrycodes=us&format=json&limit=1`, {
            headers: { 'User-Agent': 'RiverMonitorApp/1.0' }
          });
          const geoData = await geoRes.json();
          if (geoData.length > 0) {
            const lat = parseFloat(geoData[0].lat);
            const lon = parseFloat(geoData[0].lon);
            // Create a ~15 mile bounding box (approx 0.2 degrees)
            const bBox = `${(lon - 0.2).toFixed(4)},${(lat - 0.2).toFixed(4)},${(lon + 0.2).toFixed(4)},${(lat + 0.2).toFixed(4)}`;
            await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=${bBox}&hasDataTypeCd=iv&siteStatus=all`);
          }
        } catch (e) {
          console.warn('[RiverMonitor] Geocoding failed', e);
        }
      }
      
      // Strategy 3: State Code Search (2 letters)
      if (/^[A-Z]{2}$/i.test(query)) {
        await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=${query.toLowerCase()}&hasDataTypeCd=iv&siteStatus=all`);
      }
      
      // Strategy 4: Name Search
      if (results.length < 20) {
        console.log(`[RiverMonitor] Starting name-based search for: ${query}`);
        
        // Extract state code if present (e.g., "new river nc")
        const stateMatch = query.match(/\b([A-Za-z]{2})$/);
        let stateCd = '';
        let cleanQuery = query;
        
        if (stateMatch) {
          const possibleState = stateMatch[1].toLowerCase();
          const validStates = ["al","ak","az","ar","ca","co","ct","de","dc","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","pr","vi","gu","as","mp"];
          if (validStates.includes(possibleState)) {
            stateCd = possibleState;
            cleanQuery = query.replace(/\b([A-Za-z]{2})$/, '').trim();
          }
        }

        // ALWAYS try geocoding for name searches to find nearby stations
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=us&format=json&limit=1`, {
            headers: { 'User-Agent': 'RiverMonitorApp/1.0' }
          });
          const geoData = await geoRes.json();
          if (geoData.length > 0) {
            const lat = parseFloat(geoData[0].lat);
            const lon = parseFloat(geoData[0].lon);
            console.log(`[RiverMonitor] Geocoded "${query}" to ${lat}, ${lon}`);
            
            // 1. Search by name within a large bounding box (~100 miles)
            const largeBBox = `${(lon - 1.5).toFixed(4)},${(lat - 1.5).toFixed(4)},${(lon + 1.5).toFixed(4)},${(lat + 1.5).toFixed(4)}`;
            await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=${largeBBox}&siteName=${encodeURIComponent(cleanQuery)}&siteNameMatchOperator=any&siteType=ST&hasDataTypeCd=iv&siteStatus=all`);
            
            // 2. If nothing found by name, just return all stations near the geocoded location (~15 miles)
            if (results.length === 0) {
              const smallBBox = `${(lon - 0.2).toFixed(4)},${(lat - 0.2).toFixed(4)},${(lon + 0.2).toFixed(4)},${(lat + 0.2).toFixed(4)}`;
              await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=${smallBBox}&hasDataTypeCd=iv&siteStatus=all`);
            }
          }
        } catch (e) {
          console.warn('[RiverMonitor] Geocoding failed', e);
        }
        
        // If we have a state code, search directly in that state
        if (stateCd) {
          await fetchAndParse(`https://waterservices.usgs.gov/nwis/site/?format=rdb&siteName=${encodeURIComponent(cleanQuery)}&siteNameMatchOperator=any&siteType=ST&stateCd=${stateCd}&siteStatus=all`);
        }
      }

      setSearchResults(results.slice(0, 50));
      setHasSearched(true);
      setShowResults(true);
    } catch (err) {
      console.error('[RiverMonitor] Search error:', err);
      setSearchResults([]);
      setHasSearched(true);
    } finally {
      setIsSearching(false);
    }
  };

  const startInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    
    const nextTime = new Date(Date.now() + 15 * 60 * 1000);
    setNextCheckTime(nextTime);
    
    intervalRef.current = setInterval(() => {
      fetchRiverData();
      setNextCheckTime(new Date(Date.now() + 15 * 60 * 1000));
    }, 15 * 60 * 1000);
  }, [fetchRiverData]);

  useEffect(() => {
    // Initial fetch
    fetchRiverData();
    startInterval();
    
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // We only want to re-run this effect if the siteId actually changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, startInterval]);

  useEffect(() => {
    if (!nextCheckTime) return;

    const updateCountdown = () => {
      const now = new Date();
      const diff = nextCheckTime.getTime() - now.getTime();
      
      if (diff <= 0) {
        setTimeUntilCheck('Checking now...');
        return;
      }
      
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeUntilCheck(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 1000);
    return () => clearInterval(countdownInterval);
  }, [nextCheckTime]);

  const toggleFavorite = (id: string, name: string) => {
    if (favorites.some(f => f.id === id)) {
      handleSetFavorites(favorites.filter(f => f.id !== id));
    } else {
      handleSetFavorites([...favorites, { id, name }]);
    }
  };

  const addAlert = () => {
    const newAlert: Alert = {
      id: Math.random().toString(36).substr(2, 9),
      parameter: 'cfs',
      condition: 'above',
      value: '500',
      enabled: true
    };
    handleSetAlerts([...alerts, newAlert]);
    requestNotificationPermission();
  };

  const removeAlert = (id: string) => {
    handleSetAlerts(alerts.filter(a => a.id !== id));
  };

  const updateAlert = (id: string, updates: Partial<Alert>) => {
    handleSetAlerts(alerts.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const getStatus = (cfs: number) => {
    if (cfs === 0) return null;
    if (cfs < 150) return {
      text: "Low - Watch for rocks!",
      color: "text-amber-600",
      bg: "bg-amber-50",
      border: "border-amber-200",
      icon: <AlertTriangle className="w-5 h-5" />
    };
    if (cfs <= 500) return {
      text: "Perfect for Paddling!",
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      border: "border-emerald-200",
      icon: <CheckCircle2 className="w-5 h-5" />
    };
    if (cfs <= 1000) return {
      text: "Moderate - Strong Current",
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-200",
      icon: <Info className="w-5 h-5" />
    };
    return {
      text: "High - Fast Moving Water!",
      color: "text-red-600",
      bg: "bg-red-50",
      border: "border-red-200",
      icon: <AlertTriangle className="w-5 h-5" />
    };
  };

  const visibleAlerts = triggeredAlerts.filter(id => !dismissedAlerts.includes(id));

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans selection:bg-blue-100 p-4 md:p-8 flex flex-col items-center justify-center">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-4xl relative"
      >
        {/* Toast Notification */}
        <AnimatePresence>
          {toastMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="absolute top-14 right-0 z-50 bg-slate-800 text-white text-sm px-4 py-2 rounded-xl shadow-lg"
            >
              {toastMessage}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header */}
        <header className="mb-6 text-center flex flex-col items-center">
          <div className="inline-flex items-center justify-center p-3 bg-blue-600 rounded-2xl shadow-lg shadow-blue-200 mb-4">
            <Waves className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">River Water Level Monitor</h1>
          <p className="text-slate-500 text-sm mt-1">Real-time USGS Hydrological Data</p>
        </header>

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row justify-end items-center sm:items-end mb-4 gap-4 z-30 relative">
          {/* Right Side: Favorites & Settings */}
          <div className="flex flex-col items-center sm:items-end gap-1.5">
            <div className="flex items-center gap-2">
              {/* Favorites Dropdown */}
              <div className="relative" ref={favoritesRef}>
                <button 
                  onClick={() => setShowFavoritesDropdown(!showFavoritesDropdown)}
                  className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl shadow-sm border border-slate-200 hover:bg-slate-50 text-slate-600 transition-all text-sm font-medium"
                >
                  <Star className="w-4 h-4 text-amber-400 fill-current" />
                  <span>Favorites</span>
                </button>
                
                <AnimatePresence>
                  {showFavoritesDropdown && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-0 sm:left-auto sm:right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden z-50"
                    >
                      <div className="p-2">
                        {favorites.length === 0 ? (
                          <div className="p-4 text-center text-sm text-slate-400">
                            No favorites saved yet.
                          </div>
                        ) : (
                          favorites.map(fav => (
                            <button
                              key={fav.id}
                              onClick={() => {
                                fetchRiverData(fav.id);
                                setShowFavoritesDropdown(false);
                              }}
                              className="w-full text-left px-4 py-3 hover:bg-slate-50 rounded-xl transition-colors flex items-center justify-between group"
                            >
                              <div className="flex-1 min-w-0 pr-2">
                                <p className="text-xs font-bold text-blue-600 uppercase tracking-wider">{fav.id}</p>
                                <p className="text-sm font-bold text-slate-800 line-clamp-2">
                                  {fav.customName || fav.name}
                                </p>
                                {fav.customName && (
                                  <p className="text-[10px] text-slate-400 font-medium truncate italic">{fav.name}</p>
                                )}
                              </div>
                              <Navigation className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                            </button>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Settings Button */}
              <button 
                onClick={() => {
                  setActiveTab('alerts');
                  setShowSettings(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl shadow-sm border border-slate-200 hover:bg-slate-50 text-slate-600 transition-all text-sm font-medium"
                title="Alerts & Settings"
              >
                <div className="relative">
                  <Settings className="w-4 h-4 text-slate-400" />
                  {triggeredAlerts.length > 0 && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full border border-white"></span>
                  )}
                </div>
                <span>Settings</span>
              </button>

              {/* Login/Logout Button */}
              {isAuthReady ? (
                user ? (
                  <button 
                    onClick={() => signOut(auth)}
                    className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl shadow-sm border border-slate-200 hover:bg-slate-50 text-slate-600 transition-all text-sm font-medium"
                    title="Sign Out"
                  >
                    <LogOut className="w-4 h-4 text-slate-400" />
                    <span className="hidden sm:inline">Sign Out</span>
                  </button>
                ) : (
                  <button 
                    onClick={() => signInWithPopup(auth, googleProvider).catch(err => {
                      console.error("Auth error:", err);
                      if (err.code === 'auth/unauthorized-domain') {
                        alert("This domain is not authorized for Google Sign-In. Please add it to the Firebase Console -> Authentication -> Settings -> Authorized domains.");
                      } else {
                        alert("Sign in failed: " + err.message);
                      }
                    })}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-50 rounded-xl shadow-sm border border-blue-100 hover:bg-blue-100 text-blue-600 transition-all text-sm font-medium"
                    title="Sign In to Sync"
                  >
                    <LogIn className="w-4 h-4 text-blue-500" />
                    <span className="hidden sm:inline">Sign In</span>
                  </button>
                )
              ) : (
                <button 
                  disabled
                  className="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-xl shadow-sm border border-slate-100 text-slate-400 transition-all text-sm font-medium cursor-not-allowed"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline">Loading...</span>
                </button>
              )}
            </div>
            {triggeredAlerts.length > 0 ? (
              <span className="text-[11px] text-slate-500 font-medium px-1 flex items-center gap-1.5">
                <span className="w-2 h-2 bg-red-500 rounded-full inline-block"></span> Indicates you have an active alert
              </span>
            ) : (
              <span className="text-[11px] text-slate-400 font-medium px-1">Manage favorites and set alerts</span>
            )}
          </div>
        </div>

        {/* Prominent Search Bar */}
        <div className="mb-8 relative z-20" ref={searchRef}>
          <div className="flex gap-2">
            <div className="relative flex-1 group">
              <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 transition-colors ${searchInput ? 'text-blue-500' : 'text-slate-400'}`} />
              <input 
                type="text"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  if (!e.target.value) {
                    setSearchResults([]);
                    setHasSearched(false);
                    setShowResults(false);
                  }
                }}
                onKeyDown={(e) => e.key === 'Enter' && searchStations()}
                placeholder="Search by River, City, Zip, or State..."
                className="w-full pl-12 pr-24 py-4 bg-white border border-slate-200 rounded-[1.5rem] text-sm font-medium shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all placeholder:text-slate-400"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {searchInput && (
                  <button 
                    onClick={() => {
                      setSearchInput('');
                      setSearchResults([]);
                      setHasSearched(false);
                      setShowResults(false);
                    }}
                    className="p-2 rounded-full hover:bg-slate-100 text-slate-400 transition-colors"
                    title="Clear search"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <button 
              onClick={searchStations}
              disabled={isSearching}
              className="px-6 py-4 bg-blue-600 text-white rounded-[1.5rem] text-sm font-bold shadow-lg shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              <span className="hidden sm:inline">Search</span>
            </button>
          </div>

          {/* Search Results Dropdown */}
          <AnimatePresence>
            {showResults && (isSearching || searchResults.length > 0 || (hasSearched && searchResults.length === 0)) && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute top-full left-0 right-0 mt-2 bg-white rounded-[1.5rem] shadow-2xl border border-slate-100 overflow-hidden max-h-[400px] overflow-y-auto custom-scrollbar z-30"
              >
                <div className="p-2">
                  <div className="flex justify-end p-2">
                    <button 
                      onClick={() => setShowResults(false)}
                      className="p-1.5 rounded-full hover:bg-slate-100 text-slate-400 transition-colors"
                      title="Close Results"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {isSearching ? (
                    <div className="p-12 text-center">
                      <div className="relative w-16 h-16 mx-auto mb-4">
                        <div className="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-25" />
                        <div className="relative bg-white rounded-full p-4 border border-blue-100">
                          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                        </div>
                      </div>
                      <p className="text-slate-900 font-bold text-lg">Searching USGS...</p>
                      <p className="text-slate-500 text-sm">Finding active river stations</p>
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="p-12 text-center">
                      <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-100">
                        <Search className="w-8 h-8 text-slate-300" />
                      </div>
                      <p className="text-slate-900 font-bold text-lg mb-1">No stations found</p>
                      <p className="text-slate-500 text-sm max-w-[200px] mx-auto">Try searching for a river name, city, or 8-digit USGS ID</p>
                    </div>
                  ) : (
                    searchResults.map((result) => (
                      <div 
                        key={result.id}
                        className="group flex items-center justify-between p-4 hover:bg-blue-50 rounded-2xl transition-all cursor-pointer"
                        onClick={() => {
                          fetchRiverData(result.id);
                          setShowResults(false);
                          setSearchInput('');
                        }}
                      >
                        <div className="flex-1 min-w-0 pr-4">
                          <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{result.id}</p>
                          <p className="text-sm font-bold text-slate-800 line-clamp-2">{result.name}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSetDefaultSiteId(defaultSiteId === result.id ? '' : result.id);
                            }}
                            className={`p-2 rounded-xl transition-colors ${defaultSiteId === result.id ? 'text-blue-600 bg-blue-50' : 'text-slate-300 hover:text-blue-400 hover:bg-slate-100'}`}
                            title={defaultSiteId === result.id ? "Current Default" : "Set as Default"}
                          >
                            <MapPin className={`w-4 h-4 ${defaultSiteId === result.id ? 'fill-current' : ''}`} />
                          </button>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(result.id, result.name);
                            }}
                            className={`p-2 rounded-xl transition-colors ${favorites.some(f => f.id === result.id) ? 'text-amber-400 bg-amber-50' : 'text-slate-300 hover:text-slate-400 hover:bg-slate-100'}`}
                            title={favorites.some(f => f.id === result.id) ? "Remove Favorite" : "Save as Favorite"}
                          >
                            <Star className={`w-4 h-4 ${favorites.some(f => f.id === result.id) ? 'fill-current' : ''}`} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Triggered Alerts Banner */}
        <AnimatePresence>
          {visibleAlerts.length > 0 && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-4 overflow-hidden"
            >
              <div className="bg-amber-500 text-white p-4 rounded-2xl shadow-lg flex items-center gap-3">
                <BellRing className="w-5 h-5 animate-bounce" />
                <div className="flex-1">
                  <p className="text-xs font-bold uppercase tracking-wider opacity-80">
                    {visibleAlerts.length === 1 ? 'Threshold Alert' : `${visibleAlerts.length} Threshold Alerts`}
                  </p>
                  <div className="mt-1 flex flex-col gap-1">
                    {visibleAlerts.map(alertId => {
                      const alert = alerts.find(a => a.id === alertId);
                      if (!alert) return null;
                      return (
                        <p key={alertId} className="text-sm font-bold">
                          {alert.parameter === 'cfs' ? 'Discharge' : 'Gage depth'} is {alert.condition} {alert.value} {alert.parameter === 'cfs' ? 'CFS' : 'FT'}
                        </p>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      setActiveTab('alerts');
                      setShowSettings(true);
                    }}
                    className="px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-medium transition-colors"
                  >
                    Modify
                  </button>
                  <button 
                    onClick={() => setDismissedAlerts(prev => [...prev, ...visibleAlerts])}
                    className="p-1.5 bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
                    title="Dismiss"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Card */}
        <div className="bg-white rounded-[2rem] shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
          <div className="p-8">
            {/* Station Info */}
            <div className="flex items-start justify-between mb-8">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <div className="flex items-center gap-2 text-blue-600 font-semibold text-xs uppercase tracking-wider">
                    <Navigation className="w-3 h-3" />
                    Station {data?.siteCode}
                  </div>
                  {defaultSiteId && defaultSiteId !== data?.siteCode && (
                    <button 
                      onClick={() => {
                        fetchRiverData(defaultSiteId);
                        setSearchInput('');
                        setShowResults(false);
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors"
                      title="Load Default Station"
                    >
                      <MapPin className="w-3 h-3" />
                      Load Default Station
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {favorites.find(f => f.id === data?.siteCode)?.customName && (
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-[0.2em] mb-1">
                      {favorites.find(f => f.id === data?.siteCode)?.customName}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-slate-800 leading-tight">
                      {data?.siteName || (loading ? `Loading Station ${siteId}...` : 'Station Not Found')}
                    </h2>
                    {data && (
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => handleSetDefaultSiteId(defaultSiteId === data.siteCode ? '' : data.siteCode)}
                          className={`p-1 rounded-lg transition-colors ${defaultSiteId === data.siteCode ? 'text-blue-600 bg-blue-50' : 'text-slate-200 hover:text-slate-300 hover:bg-slate-50'}`}
                          title={defaultSiteId === data.siteCode ? "Current Default" : "Set as Default"}
                        >
                          <MapPin className={`w-5 h-5 ${defaultSiteId === data.siteCode ? 'fill-current' : ''}`} />
                        </button>
                        <button 
                          onClick={() => toggleFavorite(data.siteCode, data.siteName)}
                          className={`p-1 rounded-lg transition-colors ${favorites.some(f => f.id === data.siteCode) ? 'text-amber-400' : 'text-slate-200 hover:text-slate-300'}`}
                          title={favorites.some(f => f.id === data.siteCode) ? "Remove Favorite" : "Save as Favorite"}
                        >
                          <Star className={`w-5 h-5 ${favorites.some(f => f.id === data.siteCode) ? 'fill-current' : ''}`} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {data && (
                  <div className="flex flex-col gap-3 mt-2">
                    <a 
                      href={`https://waterdata.usgs.gov/monitoring-location/${data.siteCode}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-blue-500 font-bold uppercase tracking-wider hover:underline group"
                    >
                      View on USGS <ExternalLink className="w-2 h-2 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </a>
                    
                    {favorites.find(f => f.id === data.siteCode)?.notes && (
                      <div className="p-4 bg-amber-50/50 rounded-2xl border border-amber-100/50 flex items-start gap-3">
                        <StickyNote className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                        <p className="text-sm text-slate-600 italic leading-relaxed">
                          {favorites.find(f => f.id === data.siteCode)?.notes}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {data && (
                  <div className="text-right hidden sm:block">
                    <p className="text-xs font-medium text-slate-500">
                      Last Updated: {format(data.lastUpdated, 'h:mm:ss a')}
                    </p>
                    <p className="text-[10px] font-medium text-slate-400 mt-0.5">
                      Next check in: {timeUntilCheck}
                    </p>
                  </div>
                )}
                <button 
                  onClick={() => {
                    fetchRiverData();
                    startInterval();
                  }}
                  disabled={isRefreshing}
                  className={`p-2 rounded-full hover:bg-slate-50 transition-colors ${isRefreshing ? 'animate-spin text-blue-400' : 'text-slate-400'}`}
                  title="Click to refresh the data"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="py-20 flex flex-col items-center justify-center space-y-6">
                <div className="relative">
                  <div className="absolute inset-0 bg-blue-100 rounded-full blur-2xl animate-pulse" />
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin relative z-10" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-slate-900 font-bold text-lg">Loading Station {siteId}</p>
                  <p className="text-slate-500 text-sm animate-pulse">Fetching real-time USGS data...</p>
                </div>
              </div>
            ) : error ? (
              <div className="py-12 text-center max-w-md mx-auto">
                <div className="bg-red-50 text-red-600 p-8 rounded-[2rem] border border-red-100 mb-8 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-4 opacity-10">
                    <AlertTriangle className="w-24 h-24" />
                  </div>
                  <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
                  <p className="text-lg font-bold mb-2">Station Error</p>
                  <p className="text-sm opacity-90 leading-relaxed mb-6">{error}</p>
                  <div className="flex flex-col gap-2">
                    <button 
                      onClick={() => fetchRiverData()}
                      disabled={isRefreshing}
                      className="w-full py-3 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-200 flex items-center justify-center gap-2"
                    >
                      <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                      Retry Connection
                    </button>
                    <button 
                      onClick={() => {
                        setSiteId('02145000');
                        fetchRiverData('02145000');
                      }}
                      className="w-full py-3 bg-white text-red-600 border border-red-200 rounded-xl text-sm font-bold hover:bg-red-100 transition-all"
                    >
                      Try Example Station (02145000)
                    </button>
                  </div>
                </div>
                <p className="text-slate-400 text-sm">
                  Use the search bar above to find another station by name, city, or ID.
                </p>
              </div>
            ) : data && (
              <div className="space-y-8">
                {/* Stats Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 py-6">
                  {/* Flow Stat */}
                  <div className="relative group text-center flex flex-col items-center justify-center">
                    <div className="flex items-center justify-center gap-2 mb-4">
                      <Droplets className="w-5 h-5 text-[#0284C7]" />
                      <span className="text-sm font-bold text-slate-500 uppercase tracking-widest">Discharge / Flow</span>
                    </div>
                    <div className="flex items-baseline justify-center gap-2 mb-4">
                      <span className="text-7xl lg:text-8xl font-black text-[#111827] tracking-tighter">
                        {data.cfs.toLocaleString()}
                      </span>
                      <span className="text-2xl lg:text-3xl font-bold text-slate-500">CFS</span>
                    </div>
                    <p className="text-sm text-slate-500 max-w-[260px] mx-auto leading-relaxed">
                      Cubic feet per second.<br />
                      Indicates the volume of water<br />
                      moving down the river.
                    </p>
                  </div>

                  {/* Depth Stat */}
                  <div className="pt-8 md:pt-0 border-t md:border-t-0 md:border-l border-slate-100 md:pl-12 text-center flex flex-col items-center justify-center">
                    <div className="flex items-center justify-center gap-2 mb-4">
                      <Ruler className="w-5 h-5 text-[#0D9488]" />
                      <span className="text-sm font-bold text-slate-500 uppercase tracking-widest">Gage Depth</span>
                    </div>
                    <div className="flex items-baseline justify-center gap-2 mb-4">
                      <span className="text-7xl lg:text-8xl font-black text-[#111827] tracking-tighter">
                        {data.feet.toFixed(2)}
                      </span>
                      <span className="text-2xl lg:text-3xl font-bold text-slate-500">FT</span>
                    </div>
                    <p className="text-sm text-slate-500 max-w-[260px] mx-auto leading-relaxed">
                      Depth of the water at the gage<br />
                      location relative to a reference<br />
                      point.
                    </p>
                  </div>
                </div>

                {/* Status Badge */}
                {getStatus(data.cfs) && (
                  <motion.div 
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className={`flex items-center justify-center md:justify-start gap-3 p-4 rounded-2xl border ${getStatus(data.cfs)!.bg} ${getStatus(data.cfs)!.color} ${getStatus(data.cfs)!.border}`}
                  >
                    {getStatus(data.cfs)!.icon}
                    <span className="font-bold text-sm">{getStatus(data.cfs)!.text}</span>
                  </motion.div>
                )}

                {/* Paddling Cheat Sheet */}
                <div className="pt-8 border-t border-slate-50">
                  <div className="mb-4 flex flex-col md:flex-row md:items-end justify-between gap-2">
                    <div>
                      <h3 className="text-lg font-bold text-slate-800">Paddling Cheat Sheet</h3>
                      <p className="text-xs text-slate-400 font-medium">What the numbers mean for your trip</p>
                    </div>
                    <div className="text-[10px] font-bold text-blue-500 uppercase tracking-widest bg-blue-50 px-2 py-1 rounded-lg md:mb-1 self-start">
                      Standard Guidelines
                    </div>
                  </div>
                  
                  <div className="overflow-x-auto -mx-8 px-8 custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[500px] md:min-w-full">
                      <thead>
                        <tr className="border-b border-slate-50">
                          <th className="py-3 pr-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Flow (CFS)</th>
                          <th className="py-3 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Gauge Height (FT)</th>
                          <th className="py-3 pl-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">What it means for you</th>
                        </tr>
                      </thead>
                      <tbody className="text-[11px] font-medium">
                        <tr className="border-b border-slate-50 bg-yellow-50/50">
                          <td className="py-4 pr-4 pl-4 text-slate-800 font-bold whitespace-nowrap rounded-l-lg">Below 150</td>
                          <td className="py-4 px-4 text-slate-400 whitespace-nowrap">Under 1.5'</td>
                          <td className="py-4 pl-4 pr-4 text-slate-600 leading-relaxed rounded-r-lg"><span className="font-bold text-slate-800">Low:</span> Expect to "scoot" over rocks or get stuck in shallow spots.</td>
                        </tr>
                        <tr className="border-b border-slate-50 bg-green-50/50">
                          <td className="py-4 pr-4 pl-4 text-slate-800 font-bold whitespace-nowrap rounded-l-lg">150 – 500</td>
                          <td className="py-4 px-4 text-slate-400 whitespace-nowrap">1.6' – 2.7'</td>
                          <td className="py-4 pl-4 pr-4 text-slate-600 leading-relaxed rounded-r-lg"><span className="font-bold text-slate-800">Ideal:</span> Perfect for a relaxed paddle; easy to paddle upstream.</td>
                        </tr>
                        <tr className="border-b border-slate-50 bg-orange-50/50">
                          <td className="py-4 pr-4 pl-4 text-slate-800 font-bold whitespace-nowrap rounded-l-lg">500 – 1,000</td>
                          <td className="py-4 px-4 text-slate-400 whitespace-nowrap">2.7' – 4.0'</td>
                          <td className="py-4 pl-4 pr-4 text-slate-600 leading-relaxed rounded-r-lg"><span className="font-bold text-slate-800">Moderate:</span> Noticeable current. Moving upstream will be a workout.</td>
                        </tr>
                        <tr className="bg-red-100/60">
                          <td className="py-4 pr-4 pl-4 text-slate-800 font-bold whitespace-nowrap rounded-l-lg">Over 1,000</td>
                          <td className="py-4 px-4 text-slate-400 whitespace-nowrap">4.0'+</td>
                          <td className="py-4 pl-4 pr-4 text-slate-600 leading-relaxed rounded-r-lg"><span className="font-bold text-slate-800">High:</span> Water is moving fast. Not recommended for beginners or upstream paddling.</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Meta Info */}
                <div className="flex items-center justify-between pt-6 border-t border-slate-50 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                      Live Data
                    </div>
                    {lastChecked && (
                      <div className="text-[9px] opacity-60 lowercase font-medium">
                        Last Checked: {format(lastChecked, 'h:mm:ss a')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Info */}
        <footer className="mt-8 flex items-center justify-center gap-4 text-slate-400">
          <div className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-widest">
            <Info className="w-3 h-3" />
            Source: USGS Water Services
          </div>
        </footer>

        {/* Settings Modal */}
        <AnimatePresence>
          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowSettings(false)}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="relative w-full max-w-md bg-white rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                {/* Modal Header */}
                <div className="p-8 pb-4">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xl font-bold text-slate-800">Settings</h3>
                    <button 
                      onClick={() => setShowSettings(false)}
                      className="p-2 rounded-full hover:bg-slate-100 text-slate-400"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Tabs */}
                  <div className="flex p-1 bg-slate-100 rounded-2xl mb-6">
                    {(['favorites', 'alerts'] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                      >
                        {tab}
                        {tab === 'alerts' && triggeredAlerts.length > 0 && (
                          <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Modal Content */}
                <div className="flex-1 overflow-y-auto p-8 pt-0 custom-scrollbar">
                  {activeTab === 'favorites' && (
                    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-4">Saved Locations</label>
                      <div className="space-y-2">
                        {favorites.length === 0 ? (
                          <div className="text-center py-12 bg-slate-50 rounded-[2rem] border border-dashed border-slate-200">
                            <StarOff className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                            <p className="text-xs text-slate-400 font-medium">No favorites saved yet</p>
                          </div>
                        ) : (
                          favorites.map((fav) => (
                            <div 
                              key={fav.id}
                              className={`flex flex-col p-4 bg-slate-50 rounded-2xl border transition-all ${editingFavoriteId === fav.id ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-100 hover:border-blue-200'} cursor-pointer`}
                              onClick={() => {
                                fetchRiverData(fav.id);
                                setShowSettings(false);
                              }}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0 pr-4">
                                  <p className="text-xs font-bold text-blue-600 uppercase tracking-wider">{fav.id}</p>
                                  <p className="text-sm font-bold text-slate-800 line-clamp-2">
                                    {fav.customName || fav.name}
                                  </p>
                                  {fav.customName && (
                                    <p className="text-[10px] text-slate-400 font-medium truncate italic">{fav.name}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingFavoriteId(editingFavoriteId === fav.id ? null : fav.id);
                                    }}
                                    className={`p-2 rounded-xl transition-colors ${editingFavoriteId === fav.id ? 'text-blue-600 bg-blue-50' : 'text-slate-300 hover:text-blue-400 hover:bg-slate-100'}`}
                                    title="Edit Custom Name & Notes"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSetDefaultSiteId(defaultSiteId === fav.id ? '' : fav.id);
                                    }}
                                    className={`p-2 rounded-xl transition-colors ${defaultSiteId === fav.id ? 'text-blue-600 bg-blue-50' : 'text-slate-300 hover:text-blue-400 hover:bg-slate-100'}`}
                                    title={defaultSiteId === fav.id ? "Default Station" : "Set as Default"}
                                  >
                                    <MapPin className={`w-4 h-4 ${defaultSiteId === fav.id ? 'fill-current' : ''}`} />
                                  </button>
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleFavorite(fav.id, fav.name);
                                    }}
                                    className="p-2 rounded-xl text-amber-400 bg-amber-50 hover:bg-amber-100 transition-colors"
                                    title="Remove Favorite"
                                  >
                                    <Star className="w-4 h-4 fill-current" />
                                  </button>
                                </div>
                              </div>

                              {editingFavoriteId === fav.id && (
                                <motion.div 
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  className="mt-4 pt-4 border-t border-slate-200 space-y-3"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Custom Name</label>
                                    <input 
                                      type="text"
                                      value={fav.customName || ''}
                                      onChange={(e) => updateFavorite(fav.id, { customName: e.target.value })}
                                      placeholder="e.g. My Fishing Spot"
                                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:border-blue-300"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Notes</label>
                                    <textarea 
                                      value={fav.notes || ''}
                                      onChange={(e) => updateFavorite(fav.id, { notes: e.target.value })}
                                      placeholder="Add notes about this location..."
                                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:border-blue-300 h-20 resize-none"
                                    />
                                  </div>
                                </motion.div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}

                  {activeTab === 'alerts' && (
                    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-widest block">Custom Alerts</label>
                          {triggeredAlerts.length > 0 && (
                            <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1.5 mt-1">
                              <span className="w-2 h-2 bg-red-500 rounded-full inline-block"></span> Indicates an active alert
                            </span>
                          )}
                        </div>
                        <button 
                          onClick={addAlert}
                          className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 mt-0.5"
                        >
                          <Plus className="w-3 h-3" /> Add Alert
                        </button>
                      </div>

                      <div className="space-y-3">
                        {alerts.length === 0 ? (
                          <div className="text-center py-12 bg-slate-50 rounded-[2rem] border border-dashed border-slate-200">
                            <Bell className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                            <p className="text-xs text-slate-400 font-medium tracking-tight">No alerts configured</p>
                          </div>
                        ) : (
                          alerts.map((alert) => (
                            <div key={alert.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex flex-col gap-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <input 
                                    type="checkbox"
                                    checked={alert.enabled}
                                    onChange={(e) => updateAlert(alert.id, { enabled: e.target.checked })}
                                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                  />
                                  <span className="text-xs font-bold text-slate-600 uppercase">Notify if</span>
                                </div>
                                <button 
                                  onClick={() => removeAlert(alert.id)}
                                  className="text-slate-300 hover:text-red-500 transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                              
                              <div className="flex items-center gap-2">
                                {triggeredAlerts.includes(alert.id) ? (
                                  <span className="w-2 h-2 bg-red-500 rounded-full shrink-0" title="This alert is currently active"></span>
                                ) : (
                                  <span className="w-2 h-2 shrink-0"></span>
                                )}
                                <div className="grid grid-cols-3 gap-2 flex-1">
                                  <select 
                                    value={alert.parameter}
                                    onChange={(e) => updateAlert(alert.id, { parameter: e.target.value as any })}
                                    className="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-bold focus:outline-none"
                                  >
                                    <option value="cfs">Flow (CFS)</option>
                                    <option value="feet">Depth (FT)</option>
                                  </select>
                                  <select 
                                    value={alert.condition}
                                    onChange={(e) => updateAlert(alert.id, { condition: e.target.value as any })}
                                    className="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-bold focus:outline-none"
                                  >
                                    <option value="above">is above</option>
                                    <option value="below">is below</option>
                                  </select>
                                  <input 
                                    type="number"
                                    value={alert.value}
                                    onChange={(e) => updateAlert(alert.id, { value: e.target.value })}
                                    className="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-bold focus:outline-none"
                                  />
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </motion.div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </motion.div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f1f5f9;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #94a3b8;
        }
      `}</style>
    </div>
  );
}
