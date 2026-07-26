/** Generic persistence port for guild-scoped adapters. */
export interface GuildRepository<TGuild> {
    findById(guildId: string): Promise<TGuild | null>;
    save(guildId: string, guild: TGuild): Promise<void>;
}

/** Generic authorization port for guild-scoped operations. */
export interface GuildAuthorization {
    canAccess(userId: string, guildId: string): Promise<boolean>;
}
