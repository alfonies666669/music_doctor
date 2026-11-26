-- Reads one artwork in its original format without changing the track.
on run argv
    set wantedID to item 1 of argv
    set outputPath to item 2 of argv
    tell application "/System/Applications/Music.app"
        set matches to (every file track of library playlist 1 whose persistent ID is wantedID)
        if (count of matches) is not 1 then error "Track ID is not unique"
        set targetTrack to item 1 of matches
        set pictures to every artwork of targetTrack
        set pictureCount to count of pictures
        if pictureCount is not 1 then error "Expected one Music artwork; found " & pictureCount & " for " & wantedID
        set artworkBytes to raw data of item 1 of pictures
    end tell
    -- Explicit Standard Additions event codes also compile when its dictionary
    -- is not loaded by a non-interactive osascript host.
    set fileHandle to «event rdwropen» (POSIX file outputPath) with «class perm»
    try
        «event rdwrseof» fileHandle given «class set2»:0
        «event rdwrwrit» artworkBytes given «class refn»:fileHandle
        «event rdwrclos» fileHandle
    on error messageText number errorNumber
        «event rdwrclos» fileHandle
        error messageText number errorNumber
    end try
end run
