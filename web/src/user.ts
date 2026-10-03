import { createContext, useContext } from 'react';

import type { User } from './api';

export const UserContext = createContext<User | null>(null);

/** The signed-in user; only under the app's signed-in pages. */
export function useUser(): User {
    const user = useContext(UserContext);
    if (!user) throw new Error('useUser outside UserContext');
    return user;
}
