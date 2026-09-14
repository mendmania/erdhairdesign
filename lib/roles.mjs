export const OWNER_EMAIL = 'mendmania@gmail.com';
export const isAdmin = user => Boolean(user && ['admin', 'super_admin'].includes(user.role));
export const isSuperAdmin = user => Boolean(user?.verified && user.role === 'super_admin' && user.email.toLowerCase() === OWNER_EMAIL);
