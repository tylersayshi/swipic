import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  StyleSheet,
  Alert,
  Dimensions,
  Text,
  TouchableOpacity,
  AppState,
  AppStateStatus,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import { IconSymbol } from "./ui/icon-symbol";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;

export default function PhotoSwiper() {
  const [photos, setPhotos] = useState<MediaLibrary.Asset[]>([]);
  const [filteredPhotos, setFilteredPhotos] = useState<MediaLibrary.Asset[]>(
    []
  );
  const [keptPhotoIds, setKeptPhotoIds] = useState<Set<string>>(new Set());
  const [markedForDeletionIds, setMarkedForDeletionIds] = useState<Set<string>>(
    new Set()
  );
  const [deletedPhotoIds, setDeletedPhotoIds] = useState<Set<string>>(
    new Set()
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [permissionStatus, setPermissionStatus] = useState<string>("");
  const [isFinished, setIsFinished] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [lastAction, setLastAction] = useState<{
    type: "keep" | "delete";
    photoId: string;
  } | null>(null);

  const appState = useRef(AppState.currentState);

  const translateX = useSharedValue(0);
  const scale = useSharedValue(1);
  const rotation = useSharedValue(0);
  const keepOpacity = useSharedValue(0);
  const deleteOpacity = useSharedValue(0);

  const filterPhotos = useCallback(
    (allPhotos: MediaLibrary.Asset[]) => {
      const filtered = allPhotos.filter(
        (photo) =>
          !keptPhotoIds.has(photo.id) &&
          !deletedPhotoIds.has(photo.id) &&
          !markedForDeletionIds.has(photo.id)
      );
      setFilteredPhotos(filtered);
    },
    [keptPhotoIds, deletedPhotoIds, markedForDeletionIds]
  );

  const resetCard = useCallback(() => {
    translateX.value = 0;
    rotation.value = 0;
    keepOpacity.value = 0;
    deleteOpacity.value = 0;
    scale.value = 1;
  }, [translateX, rotation, keepOpacity, deleteOpacity, scale]);

  const loadPhotos = useCallback(
    async (isRefresh = false) => {
      try {
        const media = await MediaLibrary.getAssetsAsync({
          mediaType: "photo",
          first: 1000,
          sortBy: "creationTime",
        });

        // Sort newest first (descending order)
        const sortedPhotos = media.assets.sort(
          (a, b) => b.creationTime - a.creationTime
        );

        const oldPhotoCount = photos.length;
        const newPhotoCount = sortedPhotos.length;

        setPhotos(sortedPhotos);
        filterPhotos(sortedPhotos);

        // If we found new photos and we're currently finished, reset to show new photos
        if (isRefresh && newPhotoCount > oldPhotoCount && isFinished) {
          setIsFinished(false);
          setCurrentIndex(0);
          resetCard();
        }
      } catch (error) {
        console.error("Failed to load photos:", error);
      }
    },
    [filterPhotos, photos.length, isFinished, resetCard]
  );

  const requestPermission = useCallback(async () => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setPermissionStatus(status);

      if (status === "granted") {
        loadPhotos();
      } else {
        Alert.alert(
          "Permission denied",
          "Please grant photo library access to use this app"
        );
      }
    } catch (error) {
      console.error("Permission request failed:", error);
    }
  }, [loadPhotos]);

  useEffect(() => {
    requestPermission();
  }, [requestPermission]);

  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === "active"
      ) {
        // App has come to the foreground, refresh photos
        loadPhotos(true);
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange
    );

    return () => {
      subscription?.remove();
    };
  }, [loadPhotos]);

  const keepCurrentPhoto = () => {
    const currentPhoto = filteredPhotos[currentIndex];
    if (currentPhoto) {
      setLastAction({ type: "keep", photoId: currentPhoto.id });

      const newKeptIds = new Set(keptPhotoIds);
      newKeptIds.add(currentPhoto.id);
      setKeptPhotoIds(newKeptIds);

      const newFiltered = filteredPhotos.filter(
        (photo) => photo.id !== currentPhoto.id
      );
      setFilteredPhotos(newFiltered);

      if (newFiltered.length === 0 || currentIndex >= newFiltered.length) {
        setIsFinished(true);
      } else {
        resetCard();
      }
    }
  };

  const markCurrentPhotoForDeletion = () => {
    const currentPhoto = filteredPhotos[currentIndex];
    if (currentPhoto) {
      setLastAction({ type: "delete", photoId: currentPhoto.id });

      const newMarkedIds = new Set(markedForDeletionIds);
      newMarkedIds.add(currentPhoto.id);
      setMarkedForDeletionIds(newMarkedIds);

      const newFiltered = filteredPhotos.filter(
        (photo) => photo.id !== currentPhoto.id
      );
      setFilteredPhotos(newFiltered);

      if (newFiltered.length === 0 || currentIndex >= newFiltered.length) {
        setIsFinished(true);
      } else {
        resetCard();
      }
    }
  };

  const performBatchDeletion = async () => {
    if (markedForDeletionIds.size === 0) return;

    setIsDeleting(true);
    try {
      const photosToDelete = Array.from(markedForDeletionIds);
      await MediaLibrary.deleteAssetsAsync(photosToDelete);

      const newDeletedIds = new Set([
        ...deletedPhotoIds,
        ...markedForDeletionIds,
      ]);
      setDeletedPhotoIds(newDeletedIds);
      setMarkedForDeletionIds(new Set());
    } catch (error) {
      console.error("canceled delete:", error);
      // Handle user denying deletion permission as cancellation
      // Reset photos back to their original state
      setMarkedForDeletionIds(new Set());
      setIsFinished(false);
      filterPhotos(photos);
      resetCard();
    } finally {
      setIsDeleting(false);
    }
  };

  const restart = async () => {
    if (markedForDeletionIds.size > 0) {
      await performBatchDeletion();
    }

    resetCard();
    setCurrentIndex(0);
    setIsFinished(false);
    setKeptPhotoIds(new Set());
    setLastAction(null);
    const nonDeletedPhotos = photos.filter(
      (photo) => !deletedPhotoIds.has(photo.id)
    );
    setFilteredPhotos(nonDeletedPhotos);
  };

  const undoLastAction = () => {
    if (!lastAction) return;

    const { type, photoId } = lastAction;

    if (type === "keep") {
      const newKeptIds = new Set(keptPhotoIds);
      newKeptIds.delete(photoId);
      setKeptPhotoIds(newKeptIds);
    } else if (type === "delete") {
      const newMarkedIds = new Set(markedForDeletionIds);
      newMarkedIds.delete(photoId);
      setMarkedForDeletionIds(newMarkedIds);
    }

    setLastAction(null);
    setIsFinished(false);
    filterPhotos(photos);
    resetCard();
  };

  const resetWithConfirmation = () => {
    Alert.alert(
      "Reset Everything",
      "This will clear all your keep and delete choices and start over. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            setKeptPhotoIds(new Set());
            setMarkedForDeletionIds(new Set());
            setLastAction(null);
            setCurrentIndex(0);
            setIsFinished(false);
            filterPhotos(photos);
            resetCard();
          },
        },
      ]
    );
  };

  const confirmDeletion = async () => {
    if (markedForDeletionIds.size === 0) {
      Alert.alert("No Photos", "No photos are marked for deletion.");
      return;
    }

    Alert.alert(
      "Confirm Deletion",
      `Are you sure you want to delete ${markedForDeletionIds.size} photo${
        markedForDeletionIds.size === 1 ? "" : "s"
      }? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: performBatchDeletion,
        },
      ]
    );
  };

  const panGesture = Gesture.Pan()
    .onStart(() => {
      scale.value = withSpring(0.95);
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      rotation.value = event.translationX * 0.1;

      if (event.translationX > 50) {
        keepOpacity.value = Math.min(event.translationX / 150, 1);
        deleteOpacity.value = 0;
      } else if (event.translationX < -50) {
        deleteOpacity.value = Math.min(Math.abs(event.translationX) / 150, 1);
        keepOpacity.value = 0;
      } else {
        keepOpacity.value = 0;
        deleteOpacity.value = 0;
      }
    })
    .onEnd((event) => {
      if (event.translationX < -SWIPE_THRESHOLD && event.velocityX < -500) {
        // Delete - animate off screen left then delete photo
        translateX.value = withTiming(
          -SCREEN_WIDTH,
          { duration: 200 },
          (finished) => {
            if (finished) {
              scheduleOnRN(markCurrentPhotoForDeletion);
            }
          }
        );
        rotation.value = withTiming(-15, { duration: 200 });
        deleteOpacity.value = withTiming(1, { duration: 100 });
        keepOpacity.value = withTiming(0, { duration: 100 });
      } else if (
        event.translationX > SWIPE_THRESHOLD &&
        event.velocityX > 500
      ) {
        // Keep - animate off screen right then mark as kept
        translateX.value = withTiming(
          SCREEN_WIDTH,
          { duration: 200 },
          (finished) => {
            if (finished) {
              scheduleOnRN(keepCurrentPhoto);
            }
          }
        );
        rotation.value = withTiming(15, { duration: 200 });
        keepOpacity.value = withTiming(1, { duration: 100 });
        deleteOpacity.value = withTiming(0, { duration: 100 });
      } else {
        // Reset to center
        scale.value = withSpring(1);
        rotation.value = withSpring(0);
        keepOpacity.value = withSpring(0);
        deleteOpacity.value = withSpring(0);
        translateX.value = withSpring(0);
      }
    });

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: translateX.value },
        { scale: scale.value },
        { rotateZ: `${rotation.value}deg` },
      ],
    };
  });

  const keepIndicatorStyle = useAnimatedStyle(() => {
    return {
      opacity: keepOpacity.value,
    };
  });

  const deleteIndicatorStyle = useAnimatedStyle(() => {
    return {
      opacity: deleteOpacity.value,
    };
  });

  useEffect(() => {
    resetCard();
  }, [currentIndex, resetCard]);

  useEffect(() => {
    filterPhotos(photos);
  }, [
    keptPhotoIds,
    deletedPhotoIds,
    markedForDeletionIds,
    photos,
    filterPhotos,
  ]);

  if (permissionStatus !== "granted") {
    return (
      <View style={styles.container}>
        <View style={styles.permissionMessage}>
          {/* Permission request UI would go here */}
        </View>
      </View>
    );
  }

  if (photos.length === 0 && permissionStatus === "granted") {
    return (
      <View style={styles.container}>
        <View style={styles.finishedContainer}>
          <Text style={styles.finishedTitle}>No Photos Found</Text>
          <Text style={styles.finishedSubtitle}>
            Your photo library appears to be empty.
          </Text>
        </View>
      </View>
    );
  }

  if (photos.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          {/* Loading indicator would go here */}
        </View>
      </View>
    );
  }

  if (isFinished || filteredPhotos.length === 0) {
    const handleFinish = async () => {
      if (markedForDeletionIds.size > 0 && !isDeleting) {
        await performBatchDeletion();
      }
    };

    const getFinishedText = () => {
      if (isDeleting) {
        return `Deleting ${markedForDeletionIds.size} photos...`;
      }
      if (markedForDeletionIds.size > 0) {
        return `${markedForDeletionIds.size} photos marked for deletion`;
      }
      return "You've seen all your photos!";
    };

    // Automatically perform deletion when finished
    if (markedForDeletionIds.size > 0 && !isDeleting) {
      handleFinish();
    }

    return (
      <View style={styles.container}>
        <View style={styles.finishedContainer}>
          <Text style={styles.finishedTitle}>No More Images</Text>
          <Text style={styles.finishedSubtitle}>{getFinishedText()}</Text>
          <TouchableOpacity
            style={[styles.restartButton, isDeleting && { opacity: 0.5 }]}
            onPress={restart}
            disabled={isDeleting}
          >
            <Text style={styles.restartButtonText}>Start Over</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const currentPhoto = filteredPhotos[currentIndex];

  if (!currentPhoto) {
    return (
      <View style={styles.container}>
        <View style={styles.finishedContainer}>
          <Text style={styles.finishedTitle}>No More Images</Text>
          <Text style={styles.finishedSubtitle}>
            You&apos;ve seen all your photos!
          </Text>
          <TouchableOpacity style={styles.restartButton} onPress={restart}>
            <Text style={styles.restartButtonText}>Start Over</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={[styles.headerButton, !lastAction && styles.disabledButton]}
          onPress={undoLastAction}
          disabled={!lastAction}
        >
          <IconSymbol
            name="arrow.uturn.backward"
            size={24}
            color={lastAction ? "#fff" : "#666"}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerButton}
          onPress={resetWithConfirmation}
        >
          <IconSymbol name="arrow.clockwise" size={24} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.headerButton,
            markedForDeletionIds.size === 0 && styles.disabledButton,
          ]}
          onPress={confirmDeletion}
          disabled={markedForDeletionIds.size === 0}
        >
          <IconSymbol
            name="checkmark"
            size={24}
            color={markedForDeletionIds.size > 0 ? "#fff" : "#666"}
          />
        </TouchableOpacity>
      </View>

      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.cardContainer, animatedStyle]}>
          <View style={styles.card}>
            <Image
              source={{ uri: currentPhoto.uri }}
              style={styles.photo}
              contentFit="cover"
            />
          </View>

          <Animated.View style={[styles.keepIndicator, keepIndicatorStyle]}>
            <Text style={styles.indicatorText}>KEEP</Text>
          </Animated.View>

          <Animated.View style={[styles.deleteIndicator, deleteIndicatorStyle]}>
            <Text style={styles.indicatorText}>DELETE</Text>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
  },
  headerButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  disabledButton: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  cardContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: SCREEN_WIDTH - 40,
    height: SCREEN_HEIGHT * 0.75,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 15,
  },
  photo: {
    width: "100%",
    height: "100%",
  },
  keepIndicator: {
    position: "absolute",
    top: 100,
    left: 50,
    backgroundColor: "#4CAF50",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    transform: [{ rotate: "-15deg" }],
  },
  deleteIndicator: {
    position: "absolute",
    top: 100,
    right: 50,
    backgroundColor: "#F44336",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    transform: [{ rotate: "15deg" }],
  },
  indicatorText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "bold",
  },
  permissionMessage: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  finishedContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  finishedTitle: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#fff",
    marginBottom: 16,
    textAlign: "center",
  },
  finishedSubtitle: {
    fontSize: 18,
    color: "#ccc",
    marginBottom: 40,
    textAlign: "center",
  },
  restartButton: {
    backgroundColor: "#4CAF50",
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 25,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  restartButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
  },
});
