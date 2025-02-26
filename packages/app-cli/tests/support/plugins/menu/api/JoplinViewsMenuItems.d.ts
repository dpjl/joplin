import { CreateMenuItemOptions, MenuItemLocation } from './types';
import Plugin from '../Plugin';
/**
 * Allows creating and managing menu items.
 *
 * [View the demo plugin](https://github.com/dpjl/joplin/tree/dev/packages/app-cli/tests/support/plugins/register_command)
 */
export default class JoplinViewsMenuItems {
    private store;
    private plugin;
    constructor(plugin: Plugin, store: any);
    /**
     * Creates a new menu item and associate it with the given command. You can specify under which menu the item should appear using the `location` parameter.
     */
    create(id: string, commandName: string, location?: MenuItemLocation, options?: CreateMenuItemOptions): Promise<void>;
}
