import { apiRequest } from './auth'

export interface AdminSummary {
  totalUserCount: number
  totalFolderCount: number
  totalWordCount: number
}

export interface AdminUserStats {
  userId: string
  username: string
  createdAt: string
  folderCount: number
  wordCount: number
}

export interface AdminStats {
  summary: AdminSummary
  users: AdminUserStats[]
}

/** Loads server-wide counts. The server remains the authority for admin access. */
export function getAdminStats(): Promise<AdminStats> {
  return apiRequest<AdminStats>('/admin/stats')
}
