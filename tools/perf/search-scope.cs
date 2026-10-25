// search-scope: exclude folders from Windows Search indexing through the Search Crawl Scope Manager COM API.
//   search-scope.exe exclude <folder> [<folder> ...]   adds a user exclusion rule per folder, then SaveAll
//   search-scope.exe include <folder> [<folder> ...]   undoes an exclusion (an include rule)
//   search-scope.exe check <folder> [<folder> ...]     prints "included"/"excluded" per folder
// Exit 0 = done, 5 = access denied (needs an elevated run), 1 = other error. Built at install like perf-snap.
// API: https://learn.microsoft.com/windows/win32/api/searchapi/nn-searchapi-isearchcrawlscopemanager
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("AB310581-AC80-11D1-8DF3-00C04FB6EF69"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISearchManager {
	void GetIndexerVersionStr(); void GetIndexerVersion(); void GetParameter(); void SetParameter();
	void get_ProxyName(); void get_BypassList(); void SetProxy();
	[return: MarshalAs(UnmanagedType.Interface)] ISearchCatalogManager GetCatalog([MarshalAs(UnmanagedType.LPWStr)] string catalog);
}

[ComImport, Guid("AB310581-AC80-11D1-8DF3-00C04FB6EF50"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISearchCatalogManager {
	void get_Name(); void GetParameter(); void SetParameter(); void GetCatalogStatus(); void Reset(); void Reindex();
	void ReindexMatchingURLs(); void ReindexSearchRoot(); void put_ConnectTimeout(); void get_ConnectTimeout();
	void put_DataTimeout(); void get_DataTimeout(); void NumberOfItems(); void NumberOfItemsToIndex(); void URLBeingIndexed();
	void GetURLIndexingState(); void GetPersistentItemsChangedSink(); void RegisterViewForNotification();
	void GetItemsChangedSink(); void UnregisterViewForNotification(); void SetExtensionClusion(); void EnumerateExcludedExtensions();
	void GetQueryHelper(); void put_DiacriticSensitivity(); void get_DiacriticSensitivity();
	[return: MarshalAs(UnmanagedType.Interface)] ISearchCrawlScopeManager GetCrawlScopeManager();
}

[ComImport, Guid("AB310581-AC80-11D1-8DF3-00C04FB6EF55"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISearchCrawlScopeManager {
	void AddDefaultScopeRule(); void AddRoot(); void RemoveRoot(); void EnumerateRoots(); void AddHierarchicalScope();
	void AddUserScopeRule([MarshalAs(UnmanagedType.LPWStr)] string url, [MarshalAs(UnmanagedType.Bool)] bool include, [MarshalAs(UnmanagedType.Bool)] bool overrideChildren, uint followFlags);
	void RemoveScopeRule(); void EnumerateScopeRules(); void HasParentScopeRule(); void HasChildScopeRule();
	[return: MarshalAs(UnmanagedType.Bool)] bool IncludedInCrawlScope([MarshalAs(UnmanagedType.LPWStr)] string url);
	void IncludedInCrawlScopeEx(); void RevertToDefaultScopes();
	void SaveAll();
}

static class SearchScope {
	static int Main(string[] args) {
		if (args.Length < 2 || (args[0] != "exclude" && args[0] != "include" && args[0] != "check")) { Console.Error.WriteLine("usage: search-scope exclude|include|check <folder>..."); return 2; }
		try {
			var mgr = (ISearchManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("7D096C5F-AC08-4F1F-BEB7-5C22C517CE39")));
			var csm = mgr.GetCatalog("SystemIndex").GetCrawlScopeManager();
			for (int i = 1; i < args.Length; i++) {
				string url = "file:///" + args[i].TrimEnd('\\') + "\\";
				if (args[0] != "check") { csm.AddUserScopeRule(url, args[0] == "include", true, 0); Console.WriteLine(args[0] + "d " + args[i]); }
				else Console.WriteLine((csm.IncludedInCrawlScope(url) ? "included " : "excluded ") + args[i]);
			}
			if (args[0] != "check") csm.SaveAll();
			return 0;
		} catch (UnauthorizedAccessException) { Console.Error.WriteLine("access denied: run elevated"); return 5; }
		catch (Exception e) { if (e.HResult == unchecked((int)0x80070005)) { Console.Error.WriteLine("access denied: run elevated"); return 5; } Console.Error.WriteLine("search-scope: " + e.Message); return 1; }
	}
}
