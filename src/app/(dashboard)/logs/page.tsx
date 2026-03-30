"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Download,
  RefreshCw,
  Search,
  ArrowDown,
  Terminal,
  AlertCircle,
  AlertTriangle,
  Info,
  Zap,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

interface LogEntry {
  timestamp: string;
  level: "error" | "warn" | "info" | "debug";
  message: string;
}

interface LogResponse {
  logs: LogEntry[];
  count: number;
  source?: string;
  containerName?: string;
  since: string;
  level: string;
  error?: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [levelFilter, setLevelFilter] = useState("error");
  const [timeRange, setTimeRange] = useState("10m");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [logSource, setLogSource] = useState("docker");
  const [sourceLabel, setSourceLabel] = useState("docker");

  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        level: levelFilter,
        since: timeRange,
        tail: "500",
        source: logSource,
      });

      const response = await fetch(`/api/logs?${params}`);
      const data: LogResponse = await response.json();

      if (data.error) {
        toast.error(data.error);
        setLogs([]);
        return;
      }

      setLogs(data.logs);
      setSourceLabel(data.source || data.containerName || logSource);
    } catch (error) {
      toast.error("Failed to fetch logs");
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, [levelFilter, timeRange, logSource]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchLogs();
    }, 9000); // Refresh every 9 seconds

    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  useEffect(() => {
    // Filter logs by search term
    if (searchTerm) {
      const filtered = logs.filter(
        (log) =>
          log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
          log.timestamp.toLowerCase().includes(searchTerm.toLowerCase())
      );
      setFilteredLogs(filtered);
    } else {
      setFilteredLogs(logs);
    }
  }, [searchTerm, logs]);

  useEffect(() => {
    // Scroll detection
    const handleScroll = () => {
      if (!logsContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowScrollButton(!isNearBottom && logs.length > 0);
    };

    const container = logsContainerRef.current;
    container?.addEventListener("scroll", handleScroll);
    return () => container?.removeEventListener("scroll", handleScroll);
  }, [logs]);

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const downloadLogs = () => {
    const logText = filteredLogs
      .map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`)
      .join("\n");

    const blob = new Blob([logText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ea-sys-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success("Logs downloaded");
  };

  const downloadAllLogs = async () => {
    try {
      toast.info("Fetching all logs...");
      const params = new URLSearchParams({
        level: "all",
        since: "all",
        tail: "2000",
        source: logSource,
      });
      const response = await fetch(`/api/logs?${params}`);
      const data: LogResponse = await response.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      const logText = data.logs
        .map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`)
        .join("\n");
      const blob = new Blob([logText], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ea-sys-all-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${data.logs.length} log entries`);
    } catch {
      toast.error("Failed to download logs");
    }
  };

  const [clearing, setClearing] = useState(false);

  const clearLogs = async () => {
    if (logSource !== "database") {
      toast.error("Clear is only supported for database logs");
      return;
    }
    const rangeLabel = timeRange === "all" ? "ALL" : `last ${timeRange}`;
    if (!confirm(`Are you sure you want to delete ${rangeLabel} logs? This cannot be undone.`)) return;
    setClearing(true);
    try {
      const params = new URLSearchParams({ since: timeRange, source: "database" });
      const res = await fetch(`/api/logs?${params}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to clear logs");
        return;
      }
      toast.success(`Cleared ${data.deletedCount} log entries`);
      fetchLogs();
    } catch {
      toast.error("Failed to clear logs");
    } finally {
      setClearing(false);
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case "error":
        return <AlertCircle className="w-4 h-4" />;
      case "warn":
        return <AlertTriangle className="w-4 h-4" />;
      case "info":
        return <Info className="w-4 h-4" />;
      default:
        return <Zap className="w-4 h-4" />;
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-red-400 border-red-500/30 bg-red-500/5";
      case "warn":
        return "text-amber-400 border-amber-500/30 bg-amber-500/5";
      case "info":
        return "text-cyan-400 border-cyan-500/30 bg-cyan-500/5";
      default:
        return "text-gray-400 border-gray-500/30 bg-gray-500/5";
    }
  };

  const formatMessage = (message: string) => {
    // Try to parse and pretty-print JSON
    try {
      const json = JSON.parse(message);
      return (
        <pre className="text-sm overflow-x-auto">
          {JSON.stringify(json, null, 2)}
        </pre>
      );
    } catch {
      // Not JSON, return as-is
      return <span className="text-sm break-all">{message}</span>;
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[#0a0e16] overflow-hidden">
      {/* Retro grid background */}
      <div className="absolute inset-0 bg-grid-pattern opacity-10 pointer-events-none" />

      {/* Scanline effect */}
      <div className="absolute inset-0 bg-scanlines pointer-events-none opacity-5" />

      {/* Header */}
      <div className="relative z-10 border-b border-cyan-500/20 bg-[#0d1219]/80 backdrop-blur-sm">
        <div className="px-6 py-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Terminal className="w-6 h-6 text-cyan-400" />
              <h1 className="text-2xl font-bold text-cyan-400 tracking-wider font-mono">
                SYSTEM LOGS
              </h1>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1 rounded bg-cyan-500/10 border border-cyan-500/30">
              <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-xs text-cyan-400 font-mono">{sourceLabel}</span>
            </div>
            <Select value={logSource} onValueChange={(val) => { setLogSource(val); toast.success(`Switched to ${val} source`); }}>
              <SelectTrigger className="w-[140px] h-8 bg-cyan-500/10 border-cyan-500/30 text-xs text-cyan-400 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#131a27] border-cyan-500/30">
                <SelectItem value="database" className="text-cyan-100 font-mono text-xs">Database</SelectItem>
                <SelectItem value="file" className="text-cyan-100 font-mono text-xs">File</SelectItem>
                <SelectItem value="docker" className="text-cyan-100 font-mono text-xs">Docker</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            {/* Search */}
            <div className="lg:col-span-2">
              <Label className="text-xs text-cyan-400/80 font-mono mb-1.5 block">
                SEARCH
              </Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-400/50" />
                <Input
                  placeholder="Filter logs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 bg-[#131a27] border-cyan-500/30 text-cyan-100 placeholder:text-cyan-400/30 focus:border-cyan-400 focus:ring-cyan-400/20 font-mono"
                />
              </div>
            </div>

            {/* Level Filter */}
            <div>
              <Label className="text-xs text-cyan-400/80 font-mono mb-1.5 block">
                LEVEL
              </Label>
              <Select value={levelFilter} onValueChange={setLevelFilter}>
                <SelectTrigger className="bg-[#131a27] border-cyan-500/30 text-cyan-100 focus:border-cyan-400 focus:ring-cyan-400/20 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#131a27] border-cyan-500/30">
                  <SelectItem value="all" className="text-cyan-100 font-mono">All</SelectItem>
                  <SelectItem value="error" className="text-red-400 font-mono">Errors</SelectItem>
                  <SelectItem value="warn" className="text-amber-400 font-mono">Warnings</SelectItem>
                  <SelectItem value="info" className="text-cyan-400 font-mono">Info</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Time Range */}
            <div>
              <Label className="text-xs text-cyan-400/80 font-mono mb-1.5 block">
                TIME RANGE
              </Label>
              <Select value={timeRange} onValueChange={setTimeRange}>
                <SelectTrigger className="bg-[#131a27] border-cyan-500/30 text-cyan-100 focus:border-cyan-400 focus:ring-cyan-400/20 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#131a27] border-cyan-500/30">
                  <SelectItem value="10m" className="text-cyan-100 font-mono">Last 10 min</SelectItem>
                  <SelectItem value="1h" className="text-cyan-100 font-mono">Last 1 hour</SelectItem>
                  <SelectItem value="6h" className="text-cyan-100 font-mono">Last 6 hours</SelectItem>
                  <SelectItem value="24h" className="text-cyan-100 font-mono">Last 24 hours</SelectItem>
                  <SelectItem value="all" className="text-cyan-100 font-mono">All logs</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Actions */}
            <div className="flex items-end gap-2 flex-wrap">
              <Button
                onClick={() => {
                  setAutoRefresh(!autoRefresh);
                  toast.success(autoRefresh ? "Auto-refresh disabled" : "Auto-refresh enabled");
                }}
                variant={autoRefresh ? "default" : "outline"}
                className={
                  autoRefresh
                    ? "bg-cyan-500 hover:bg-cyan-600 text-black font-mono border-0"
                    : "border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300 font-mono"
                }
                size="sm"
              >
                <RefreshCw className={`w-4 h-4 mr-1.5 ${autoRefresh ? "animate-spin" : ""}`} />
                Auto
              </Button>
              <Button
                onClick={downloadLogs}
                disabled={filteredLogs.length === 0}
                variant="outline"
                className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300 font-mono"
                size="sm"
              >
                <Download className="w-4 h-4 mr-1.5" />
                Export
              </Button>
              <Button
                onClick={downloadAllLogs}
                variant="outline"
                className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300 font-mono"
                size="sm"
              >
                <Download className="w-4 h-4 mr-1.5" />
                All
              </Button>
              {logSource === "database" && (
                <Button
                  onClick={clearLogs}
                  disabled={clearing}
                  variant="outline"
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300 font-mono"
                  size="sm"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-4 mt-3 text-xs text-cyan-400/60 font-mono">
            <div>
              <span className="text-cyan-400">{filteredLogs.length}</span> entries
              {searchTerm && <span> (filtered from {logs.length})</span>}
            </div>
            {autoRefresh && (
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                <span>Live</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Logs Container */}
      <div
        ref={logsContainerRef}
        className="flex-1 overflow-y-auto px-6 py-4 relative z-10 scroll-smooth"
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
              <p className="text-cyan-400/60 font-mono text-sm">Loading logs...</p>
            </div>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Terminal className="w-12 h-12 text-cyan-400/30 mx-auto mb-3" />
              <p className="text-cyan-400/60 font-mono text-sm">No logs found</p>
              {searchTerm && (
                <p className="text-cyan-400/40 font-mono text-xs mt-2">
                  Try adjusting your search or filters
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2 pb-20">
            {filteredLogs.map((log, index) => (
              <div
                key={index}
                className={`
                  border-l-2 pl-4 py-2 rounded-r backdrop-blur-sm
                  transition-all duration-300 ease-out
                  hover:bg-cyan-500/5 hover:border-l-cyan-400
                  ${getLevelColor(log.level)}
                  animate-slide-in
                `}
                style={{
                  animationDelay: `${Math.min(index * 20, 500)}ms`,
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex items-center gap-2 min-w-[140px] mt-0.5">
                    {getLevelIcon(log.level)}
                    <span className="text-xs text-cyan-400/70 font-mono">
                      {formatTimestamp(log.timestamp)}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0 text-cyan-100/90 font-mono">
                    {formatMessage(log.message)}
                  </div>
                </div>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* Scroll to Bottom Button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-8 right-8 z-20 bg-cyan-500 hover:bg-cyan-400 text-black font-mono text-sm px-4 py-2 rounded-lg shadow-lg shadow-cyan-500/50 flex items-center gap-2 transition-all duration-300 hover:shadow-cyan-400/60 hover:scale-105 animate-bounce-subtle"
        >
          <ArrowDown className="w-4 h-4" />
          New Logs
        </button>
      )}

      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');

        .font-mono {
          font-family: 'JetBrains Mono', 'Courier New', monospace;
        }

        .bg-grid-pattern {
          background-image:
            linear-gradient(to right, rgba(0, 170, 222, 0.1) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(0, 170, 222, 0.1) 1px, transparent 1px);
          background-size: 40px 40px;
        }

        .bg-scanlines {
          background-image:
            repeating-linear-gradient(
              0deg,
              rgba(0, 0, 0, 0.15) 0px,
              transparent 1px,
              transparent 2px,
              rgba(0, 0, 0, 0.15) 3px
            );
        }

        @keyframes slide-in {
          from {
            opacity: 0;
            transform: translateX(-10px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .animate-slide-in {
          animation: slide-in 0.3s ease-out forwards;
        }

        @keyframes bounce-subtle {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-5px);
          }
        }

        .animate-bounce-subtle {
          animation: bounce-subtle 2s ease-in-out infinite;
        }

        /* Custom scrollbar */
        ::-webkit-scrollbar {
          width: 8px;
        }

        ::-webkit-scrollbar-track {
          background: rgba(0, 170, 222, 0.05);
        }

        ::-webkit-scrollbar-thumb {
          background: rgba(0, 170, 222, 0.3);
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 170, 222, 0.5);
        }
      `}</style>
    </div>
  );
}
