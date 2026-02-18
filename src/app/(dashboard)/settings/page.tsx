"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Settings,
  Building2,
  Users,
  Plus,
  Trash2,
  Edit,
  Save,
  Mail,
  Loader2,
  Key,
  Copy,
  Check,
} from "lucide-react";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/hooks/use-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  settings: {
    timezone?: string;
    dateFormat?: string;
    currency?: string;
    emailNotifications?: boolean;
  };
  _count: {
    events: number;
    users: number;
  };
}

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  createdAt: string;
}

const timezones = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

const currencies = ["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD"];

const dateFormats = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY (US)" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY (EU)" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO)" },
];

export default function SettingsPage() {
  const { data: session, update: updateSession } = useSession();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isUserDialogOpen, setIsUserDialogOpen] = useState(false);
  const showDelayedLoader = useDelayedLoading(loading, 1000);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [orgFormData, setOrgFormData] = useState({
    name: "",
    timezone: "UTC",
    dateFormat: "MM/DD/YYYY",
    currency: "USD",
    emailNotifications: true,
  });

  const [userFormData, setUserFormData] = useState({
    email: "",
    firstName: "",
    lastName: "",
    role: "ORGANIZER",
  });

  const isAdmin = session?.user?.role === "ADMIN" || session?.user?.role === "SUPER_ADMIN";

  useEffect(() => {
    fetchOrganization();
    fetchUsers();
  }, []);

  const fetchOrganization = async () => {
    try {
      const res = await fetch("/api/organization");
      if (res.ok) {
        const data = await res.json();
        setOrganization(data);
        setOrgFormData({
          name: data.name,
          timezone: data.settings?.timezone || "UTC",
          dateFormat: data.settings?.dateFormat || "MM/DD/YYYY",
          currency: data.settings?.currency || "USD",
          emailNotifications: data.settings?.emailNotifications ?? true,
        });
      }
    } catch (error) {
      console.error("Error fetching organization:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/organization/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
      }
    } catch (error) {
      console.error("Error fetching users:", error);
    }
  };

  const handleSaveOrganization = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/organization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: orgFormData.name,
          settings: {
            timezone: orgFormData.timezone,
            dateFormat: orgFormData.dateFormat,
            currency: orgFormData.currency,
            emailNotifications: orgFormData.emailNotifications,
          },
        }),
      });

      if (res.ok) {
        fetchOrganization();
        // Refresh session to update organization name in header
        await updateSession();
        toast.success("Organization settings saved");
      } else {
        toast.error("Failed to save organization settings");
      }
    } catch (error) {
      console.error("Error saving organization:", error);
      toast.error("Failed to save organization settings");
    } finally {
      setSaving(false);
    }
  };

  const [isSubmittingUser, setIsSubmittingUser] = useState(false);

  const handleUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingUser(true);
    try {
      if (editingUser) {
        const res = await fetch(`/api/organization/users/${editingUser.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: userFormData.firstName,
            lastName: userFormData.lastName,
            role: userFormData.role,
          }),
        });
        if (res.ok) {
          toast.success("User updated successfully");
          fetchUsers();
          setIsUserDialogOpen(false);
          resetUserForm();
        } else {
          const data = await res.json();
          toast.error(data.error || "Failed to update user");
        }
      } else {
        const res = await fetch("/api/organization/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(userFormData),
        });
        const data = await res.json();
        if (res.ok) {
          if (data.invitationSent) {
            toast.success(
              `Invitation sent to ${userFormData.email}! They will receive an email to set up their account.`,
              { duration: 5000 }
            );
          } else {
            toast.warning(
              "User created but invitation email could not be sent. Please contact them directly.",
              { duration: 5000 }
            );
          }
          fetchUsers();
          setIsUserDialogOpen(false);
          resetUserForm();
        } else {
          toast.error(data.error || "Failed to create user");
        }
      }
    } catch (error) {
      console.error("Error saving user:", error);
      toast.error("An error occurred. Please try again.");
    } finally {
      setIsSubmittingUser(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm("Are you sure you want to delete this user?")) return;

    try {
      const res = await fetch(`/api/organization/users/${userId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchUsers();
      }
    } catch (error) {
      console.error("Error deleting user:", error);
    }
  };

  const openEditUserDialog = (user: User) => {
    setEditingUser(user);
    setUserFormData({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    });
    setIsUserDialogOpen(true);
  };

  const resetUserForm = () => {
    setEditingUser(null);
    setUserFormData({
      email: "",
      firstName: "",
      lastName: "",
      role: "ORGANIZER",
    });
  };

  const roleColors: Record<string, string> = {
    SUPER_ADMIN: "bg-red-100 text-red-800",
    ADMIN: "bg-purple-100 text-purple-800",
    ORGANIZER: "bg-blue-100 text-blue-800",
    REVIEWER: "bg-green-100 text-green-800",
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? (
          <ReloadingSpinner />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Settings className="h-8 w-8" />
          Settings
        </h1>
        <p className="text-muted-foreground">
          Manage your organization settings and team members
        </p>
      </div>

      {/* Organization Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Organization Settings
          </CardTitle>
          <CardDescription>
            Configure your organization&apos;s general settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="orgName">Organization Name</Label>
              <Input
                id="orgName"
                value={orgFormData.name}
                onChange={(e) =>
                  setOrgFormData({ ...orgFormData, name: e.target.value })
                }
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={organization?.slug || ""}
                disabled
                className="bg-muted"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="timezone">Default Timezone</Label>
              <Select
                value={orgFormData.timezone}
                onValueChange={(value) =>
                  setOrgFormData({ ...orgFormData, timezone: value })
                }
                disabled={!isAdmin}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dateFormat">Date Format</Label>
              <Select
                value={orgFormData.dateFormat}
                onValueChange={(value) =>
                  setOrgFormData({ ...orgFormData, dateFormat: value })
                }
                disabled={!isAdmin}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dateFormats.map((df) => (
                    <SelectItem key={df.value} value={df.value}>
                      {df.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="currency">Default Currency</Label>
              <Select
                value={orgFormData.currency}
                onValueChange={(value) =>
                  setOrgFormData({ ...orgFormData, currency: value })
                }
                disabled={!isAdmin}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Email Notifications</Label>
              <p className="text-sm text-muted-foreground">
                Receive email notifications for important events
              </p>
            </div>
            <Switch
              checked={orgFormData.emailNotifications}
              onCheckedChange={(checked) =>
                setOrgFormData({ ...orgFormData, emailNotifications: checked })
              }
              disabled={!isAdmin}
            />
          </div>

          {isAdmin && (
            <div className="flex justify-end">
              <Button onClick={handleSaveOrganization} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Team Members */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Team Members
              </CardTitle>
              <CardDescription>
                Manage users who have access to your organization
              </CardDescription>
            </div>
            {isAdmin && (
              <Dialog
                open={isUserDialogOpen}
                onOpenChange={(open) => {
                  setIsUserDialogOpen(open);
                  if (!open) resetUserForm();
                }}
              >
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Add User
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {editingUser ? "Edit User" : "Add New User"}
                    </DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleUserSubmit} className="space-y-4">
                    {!editingUser && (
                      <div className="space-y-2">
                        <Label htmlFor="email">Email</Label>
                        <Input
                          id="email"
                          type="email"
                          value={userFormData.email}
                          onChange={(e) =>
                            setUserFormData({
                              ...userFormData,
                              email: e.target.value,
                            })
                          }
                          required
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="firstName">First Name</Label>
                        <Input
                          id="firstName"
                          value={userFormData.firstName}
                          onChange={(e) =>
                            setUserFormData({
                              ...userFormData,
                              firstName: e.target.value,
                            })
                          }
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="lastName">Last Name</Label>
                        <Input
                          id="lastName"
                          value={userFormData.lastName}
                          onChange={(e) =>
                            setUserFormData({
                              ...userFormData,
                              lastName: e.target.value,
                            })
                          }
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="role">Role</Label>
                      <Select
                        value={userFormData.role}
                        onValueChange={(value) =>
                          setUserFormData({ ...userFormData, role: value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          <SelectItem value="ORGANIZER">Organizer</SelectItem>
                          <SelectItem value="REVIEWER">Reviewer</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {!editingUser && (
                      <div className="flex items-center gap-2 p-3 bg-muted rounded-lg text-sm">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          An invitation email will be sent to set up their account
                        </span>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsUserDialogOpen(false)}
                        disabled={isSubmittingUser}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={isSubmittingUser}>
                        {isSubmittingUser && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        {editingUser ? "Save Changes" : "Send Invitation"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                {isAdmin && <TableHead className="w-[100px]">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.firstName} {user.lastName}
                    {user.id === session?.user?.id && (
                      <Badge variant="outline" className="ml-2">
                        You
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <Badge className={roleColors[user.role]} variant="outline">
                      {user.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(user.createdAt).toLocaleDateString()}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditUserDialog(user)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        {user.id !== session?.user?.id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteUser(user.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {organization?._count.events || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Team Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {organization?._count.users || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* API Keys */}
      {isAdmin && <ApiKeysCard />}
    </div>
  );
}

// ── API Keys sub-component ────────────────────────────────────────────────────
function ApiKeysCard() {
  const { data: apiKeys = [], isLoading } = useApiKeys();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();

  const [name, setName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const result = await createKey.mutateAsync({ name: name.trim() });
      setNewKey(result.key);
      setName("");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    }
  };

  const copyKey = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async () => {
    if (!revokeId) return;
    try {
      await revokeKey.mutateAsync(revokeId);
      toast.success("API key revoked");
    } catch {
      toast.error("Failed to revoke key");
    }
    setRevokeId(null);
  };

  const formatLastUsed = (d: string | null) =>
    d ? new Date(d).toLocaleDateString() : "Never";

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                API Keys
              </CardTitle>
              <CardDescription className="mt-1">
                Use API keys to connect external tools (e.g. n8n) to the MMG Events API.
                Send the key in an <code className="text-xs bg-muted px-1 py-0.5 rounded">x-api-key</code> header.
              </CardDescription>
            </div>
            <Button size="sm" className="btn-gradient" onClick={() => { setNewKey(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" /> New Key
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : (apiKeys as ApiKeyRow[]).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No API keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key prefix</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(apiKeys as ApiKeyRow[]).map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded">{k.prefix}…</code>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatLastUsed(k.lastUsedAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setRevokeId(k.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* n8n instructions */}
          <div className="mt-6 rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
            <p className="font-medium">n8n HTTP Request setup</p>
            <p className="text-muted-foreground">Add a header to your HTTP Request node:</p>
            <div className="font-mono text-xs bg-background rounded border px-3 py-2 space-y-1">
              <div><span className="text-blue-600">Header:</span> x-api-key</div>
              <div><span className="text-blue-600">Value:</span>  {'<your key>'}</div>
            </div>
            <p className="text-muted-foreground">Example URLs:</p>
            <div className="font-mono text-xs bg-background rounded border px-3 py-2 space-y-1">
              <div>GET /api/events/EVENT_ID/speakers</div>
              <div>GET /api/events/EVENT_ID/registrations</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) { setNewKey(null); } setDialogOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
          </DialogHeader>
          {newKey ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Copy your key now — it will <strong>not</strong> be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted rounded px-3 py-2 break-all">{newKey}</code>
                <Button size="icon" variant="outline" onClick={copyKey}>
                  {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <Button className="w-full btn-gradient" onClick={() => { setNewKey(null); setDialogOpen(false); }}>
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Key Name</Label>
                <Input
                  placeholder="e.g. n8n automation"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" className="btn-gradient" disabled={createKey.isPending}>
                  {createKey.isPending ? "Creating…" : "Create Key"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeId} onOpenChange={(o) => !o && setRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Any n8n workflows or integrations using this key will stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleRevoke}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}
