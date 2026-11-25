export type UserRole = 'host' | 'tenant' | 'admin' | 'moderator' | 'support' | 'finance';

export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}