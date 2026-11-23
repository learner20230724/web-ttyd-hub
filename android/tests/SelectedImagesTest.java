package cn.guihualab.ttydhub;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import java.util.Arrays;

public class SelectedImagesTest {
    private static void check(Intent intent, Uri... expected) {
        Uri[] actual = MainActivity.selectedImages(intent);
        if (!Arrays.equals(actual, expected.length == 0 ? null : expected)) {
            throw new AssertionError(Arrays.toString(actual));
        }
    }

    public static void main(String[] args) {
        Uri first = Uri.parse("content://photos/1"), second = Uri.parse("content://photos/2");
        Intent result = new Intent();
        check(null);
        check(result);
        check(result.setData(first), first);
        result.setData(null);
        ClipData clip = ClipData.newRawUri("photo", first);
        result.setClipData(clip);
        check(result, first);
        clip.addItem(new ClipData.Item(second));
        result.setData(first);
        check(result, first, second);
        clip.addItem(new ClipData.Item(Uri.parse("file:///invalid")));
        check(result, first, second);
        result.setClipData(null);
        check(result.setData(Uri.parse("file:///invalid")));
        System.out.println("Passed Android single URI, clip-only, multiple, duplicate and invalid result tests");
    }
}
